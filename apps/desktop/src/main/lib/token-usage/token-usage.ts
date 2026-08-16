import type { Dirent } from "node:fs";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
	calculateCacheSavingsUsd,
	calculateCostUsd,
	lookupPricing,
} from "./pricing";

const CACHE_TTL_MS = 60_000;
const FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const RATE_LIMIT_TAIL_BYTES = 512 * 1_024;
const RATE_LIMIT_FILE_LIMIT = 32;

export type TokenUsageProvider = "codex" | "claude";

export interface TokenUsageWindow {
	id: string;
	label: string;
	windowMinutes: number | null;
	usedPercent: number;
	resetsAt: number | null;
}

export interface TokenUsagePeriod {
	startAt: number;
	endAt: number;
	label: string;
	resetBased: boolean;
}

export interface TokenTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
}

export interface TokenUsageModel extends TokenTotals {
	model: string;
	totalTokens: number;
	costUsd: number;
	messages: number;
	pricingKnown: boolean;
}

export interface TokenUsageDay {
	day: string;
	costUsd: number;
	totalTokens: number;
}

export interface ProviderTokenUsageSnapshot {
	provider: TokenUsageProvider;
	available: boolean;
	windows: TokenUsageWindow[];
	costUsd: number;
	cacheSavingsUsd: number;
	totalTokens: number;
	tokens: TokenTotals;
	messages: number;
	sessions: number;
	activeDays: number;
	models: TokenUsageModel[];
	days: TokenUsageDay[];
	latestActivityAt: number | null;
}

export interface TokenUsageSnapshot {
	providers: ProviderTokenUsageSnapshot[];
	period: TokenUsagePeriod;
	collectedAt: number;
}

interface CandidateTranscript {
	path: string;
	size: number;
	mtimeMs: number;
}

interface ModelBucket extends TokenTotals {
	costUsd: number;
	messages: number;
	pricingKnown: boolean;
}

interface ProviderAccumulator {
	models: Map<string, ModelBucket>;
	days: Map<string, { costUsd: number; totalTokens: number }>;
	sessions: Set<string>;
	activeDays: Set<string>;
	cacheSavingsUsd: number;
	latestActivityAt: number | null;
}

interface CodexScanState {
	model: string;
	sessionId: string;
	lastUsageSignature: string | null;
	sawSessionMeta: boolean;
	suppressingForkCopies: boolean;
	forkCopyAnchorMs: number;
}

let cachedSnapshot: TokenUsageSnapshot | null = null;
let cacheExpiresAt = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toPositiveInt(value: unknown): number {
	const number = asFiniteNumber(value);
	return number !== null && number > 0 ? Math.trunc(number) : 0;
}

function parseTimestamp(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function formatWindowLabel(windowMinutes: number | null): string {
	if (!windowMinutes || windowMinutes <= 0) return "Limit";
	if (windowMinutes % (60 * 24 * 7) === 0) {
		return `${windowMinutes / (60 * 24 * 7)}w`;
	}
	if (windowMinutes % (60 * 24) === 0) return `${windowMinutes / (60 * 24)}d`;
	if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
	return `${windowMinutes}m`;
}

function normalizeWindow(id: string, value: unknown): TokenUsageWindow | null {
	if (!isRecord(value)) return null;
	const usedPercent = asFiniteNumber(value.used_percent);
	if (usedPercent === null) return null;
	const resetsAtSeconds = asFiniteNumber(value.resets_at);
	const windowMinutes = asFiniteNumber(value.window_minutes);
	return {
		id,
		label: formatWindowLabel(windowMinutes),
		windowMinutes,
		usedPercent: Math.min(100, Math.max(0, usedPercent)),
		resetsAt:
			resetsAtSeconds === null ? null : Math.round(resetsAtSeconds * 1_000),
	};
}

export function parseTokenUsageSnapshotLine(
	line: string,
	fallbackUpdatedAt: number,
): { windows: TokenUsageWindow[]; updatedAt: number } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || !isRecord(parsed.payload)) return null;
	const rateLimits = parsed.payload.rate_limits;
	if (!isRecord(rateLimits)) return null;
	const windows = [
		normalizeWindow("primary", rateLimits.primary),
		normalizeWindow("secondary", rateLimits.secondary),
		normalizeWindow("individual", rateLimits.individual_limit),
	].filter((window): window is TokenUsageWindow => window !== null);
	if (windows.length === 0) return null;
	return {
		windows,
		updatedAt: Math.round(
			parseTimestamp(parsed.timestamp) ?? fallbackUpdatedAt,
		),
	};
}

function emptyTokens(): TokenTotals {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
	};
}

function newAccumulator(): ProviderAccumulator {
	return {
		models: new Map(),
		days: new Map(),
		sessions: new Set(),
		activeDays: new Set(),
		cacheSavingsUsd: 0,
		latestActivityAt: null,
	};
}

function totalTokens(tokens: TokenTotals): number {
	return (
		tokens.inputTokens +
		tokens.outputTokens +
		tokens.cacheReadTokens +
		tokens.cacheWriteTokens
	);
}

function recordUsage(
	accumulator: ProviderAccumulator,
	model: string,
	tokens: TokenTotals,
	costUsd: number,
	cacheSavingsUsd: number,
	pricingKnown: boolean,
	timestamp: number | null,
	sessionId: string,
): void {
	let bucket = accumulator.models.get(model);
	if (!bucket) {
		bucket = { ...emptyTokens(), costUsd: 0, messages: 0, pricingKnown };
		accumulator.models.set(model, bucket);
	}
	bucket.inputTokens += tokens.inputTokens;
	bucket.outputTokens += tokens.outputTokens;
	bucket.cacheReadTokens += tokens.cacheReadTokens;
	bucket.cacheWriteTokens += tokens.cacheWriteTokens;
	bucket.reasoningTokens += tokens.reasoningTokens;
	bucket.costUsd += costUsd;
	accumulator.cacheSavingsUsd += cacheSavingsUsd;
	bucket.messages += 1;
	bucket.pricingKnown = bucket.pricingKnown && pricingKnown;
	if (sessionId) accumulator.sessions.add(sessionId);
	if (timestamp !== null) {
		const date = new Date(timestamp);
		const day = [
			date.getFullYear(),
			String(date.getMonth() + 1).padStart(2, "0"),
			String(date.getDate()).padStart(2, "0"),
		].join("-");
		accumulator.activeDays.add(day);
		const dayBucket = accumulator.days.get(day) ?? {
			costUsd: 0,
			totalTokens: 0,
		};
		dayBucket.costUsd += costUsd;
		dayBucket.totalTokens += totalTokens(tokens);
		accumulator.days.set(day, dayBucket);
	}
	if (
		timestamp !== null &&
		(accumulator.latestActivityAt === null ||
			timestamp > accumulator.latestActivityAt)
	) {
		accumulator.latestActivityAt = timestamp;
	}
}

async function listTranscriptFiles(
	root: string,
): Promise<CandidateTranscript[]> {
	const directories = [root];
	const files: CandidateTranscript[] = [];
	while (directories.length > 0) {
		const directory = directories.pop();
		if (!directory) continue;
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				directories.push(path);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			try {
				const stats = await stat(path);
				files.push({ path, size: stats.size, mtimeMs: stats.mtimeMs });
			} catch {
				// A running agent can rotate a transcript while it is scanned.
			}
		}
	}
	return files;
}

async function* readJsonLines(
	path: string,
	start = 0,
): AsyncGenerator<Record<string, unknown>> {
	const stream = createReadStream(path, { encoding: "utf8", start });
	try {
		const lines = createInterface({ input: stream, crlfDelay: Infinity });
		for await (const line of lines) {
			if (!line) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isRecord(parsed)) yield parsed;
			} catch {
				// A torn final line is expected while an agent is writing.
			}
		}
	} finally {
		stream.destroy();
	}
}

function isWithinWindow(
	timestamp: number | null,
	period: TokenUsagePeriod,
): boolean {
	return (
		timestamp !== null &&
		timestamp >= period.startAt &&
		timestamp < period.endAt
	);
}

function candidateFiles(
	files: CandidateTranscript[],
	sinceMs: number,
): CandidateTranscript[] {
	const oneDaySlack = 24 * 60 * 60 * 1_000;
	return files.filter((file) => file.mtimeMs >= sinceMs - oneDaySlack);
}

async function scanClaude(
	root: string,
	period: TokenUsagePeriod,
): Promise<ProviderTokenUsageSnapshot> {
	const allFiles = await listTranscriptFiles(join(root, "projects"));
	const files = candidateFiles(allFiles, period.startAt);
	const accumulator = newAccumulator();
	const seenMessages = new Set<string>();

	for (const file of files) {
		for await (const entry of readJsonLines(file.path)) {
			if (entry.type !== "assistant" || !isRecord(entry.message)) continue;
			const usage = entry.message.usage;
			if (!isRecord(usage)) continue;
			const timestamp = parseTimestamp(entry.timestamp);
			if (!isWithinWindow(timestamp, period)) continue;

			const messageId = entry.message.id;
			if (typeof messageId === "string" && messageId) {
				const dedupeKey = `${messageId}:${String(entry.requestId ?? "")}`;
				if (seenMessages.has(dedupeKey)) continue;
				seenMessages.add(dedupeKey);
			}
			const model =
				typeof entry.message.model === "string"
					? entry.message.model
					: "unknown";
			if (model === "<synthetic>") continue;
			const cacheCreation = isRecord(usage.cache_creation)
				? usage.cache_creation
				: null;
			const cacheWrite1h = toPositiveInt(
				cacheCreation?.ephemeral_1h_input_tokens,
			);
			const cacheWrite5m = cacheCreation
				? toPositiveInt(cacheCreation.ephemeral_5m_input_tokens)
				: toPositiveInt(usage.cache_creation_input_tokens);
			const tokens: TokenTotals = {
				inputTokens: toPositiveInt(usage.input_tokens),
				outputTokens: toPositiveInt(usage.output_tokens),
				cacheReadTokens: toPositiveInt(usage.cache_read_input_tokens),
				cacheWriteTokens: cacheWrite5m + cacheWrite1h,
				reasoningTokens: 0,
			};
			const pricing = lookupPricing(model);
			const costUsd = pricing
				? calculateCostUsd(
						{
							...tokens,
							cacheWrite5mTokens: cacheWrite5m,
							cacheWrite1hTokens: cacheWrite1h,
						},
						pricing,
					)
				: 0;
			recordUsage(
				accumulator,
				model,
				tokens,
				typeof entry.costUSD === "number" ? entry.costUSD : costUsd,
				pricing ? calculateCacheSavingsUsd(tokens.cacheReadTokens, pricing) : 0,
				!!pricing || typeof entry.costUSD === "number",
				timestamp,
				typeof entry.sessionId === "string" ? entry.sessionId : "",
			);
		}
	}

	return finalizeProvider("claude", accumulator, allFiles.length > 0, []);
}

function initialCodexScanState(): CodexScanState {
	return {
		model: "",
		sessionId: "",
		lastUsageSignature: null,
		sawSessionMeta: false,
		suppressingForkCopies: false,
		forkCopyAnchorMs: 0,
	};
}

function isForkedSession(payload: Record<string, unknown>): boolean {
	if (typeof payload.forked_from_id === "string") return true;
	if (!isRecord(payload.source) || !isRecord(payload.source.subagent))
		return false;
	const spawn = payload.source.subagent.thread_spawn;
	return isRecord(spawn) && typeof spawn.parent_thread_id === "string";
}

function resolveRollingPeriod(nowMs: number): TokenUsagePeriod {
	return {
		startAt: nowMs - FALLBACK_WINDOW_MS,
		endAt: nowMs,
		label: "Last 7 days",
		resetBased: false,
	};
}

async function findLatestCodexLimits(
	files: CandidateTranscript[],
): Promise<{ windows: TokenUsageWindow[]; updatedAt: number } | null> {
	let latest: { windows: TokenUsageWindow[]; updatedAt: number } | null = null;
	const newest = files
		.toSorted((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(0, RATE_LIMIT_FILE_LIMIT);
	for (const file of newest) {
		const start = Math.max(0, file.size - RATE_LIMIT_TAIL_BYTES);
		for await (const entry of readJsonLines(file.path, start)) {
			const parsed = parseTokenUsageSnapshotLine(
				JSON.stringify(entry),
				file.mtimeMs,
			);
			if (parsed && (!latest || parsed.updatedAt > latest.updatedAt))
				latest = parsed;
		}
	}
	return latest;
}

async function scanCodex(
	allFiles: CandidateTranscript[],
	period: TokenUsagePeriod,
	latestLimits: { windows: TokenUsageWindow[]; updatedAt: number } | null,
): Promise<ProviderTokenUsageSnapshot> {
	const files = candidateFiles(allFiles, period.startAt);
	const accumulator = newAccumulator();

	for (const file of files) {
		const state = initialCodexScanState();
		for await (const entry of readJsonLines(file.path)) {
			const payload = isRecord(entry.payload) ? entry.payload : null;
			if (!payload) continue;
			if (entry.type === "session_meta") {
				if (state.sawSessionMeta) continue;
				state.sawSessionMeta = true;
				const id = payload.id ?? payload.session_id;
				if (typeof id === "string") state.sessionId = id;
				const timestamp = parseTimestamp(entry.timestamp);
				if (timestamp !== null && isForkedSession(payload)) {
					state.suppressingForkCopies = true;
					state.forkCopyAnchorMs = timestamp;
				}
				continue;
			}
			if (entry.type === "turn_context") {
				if (typeof payload.model === "string") state.model = payload.model;
				continue;
			}
			if (payload.type !== "token_count" || !isRecord(payload.info)) continue;
			const last = payload.info.last_token_usage;
			if (!isRecord(last) || !state.model) continue;
			const timestamp = parseTimestamp(entry.timestamp);
			if (timestamp === null) continue;
			const signature = JSON.stringify(last);
			if (signature === state.lastUsageSignature) continue;
			state.lastUsageSignature = signature;
			if (state.suppressingForkCopies) {
				if (timestamp - state.forkCopyAnchorMs < 1_000) {
					state.forkCopyAnchorMs = timestamp;
					continue;
				}
				state.suppressingForkCopies = false;
			}
			if (!isWithinWindow(timestamp, period)) continue;
			const input = toPositiveInt(last.input_tokens);
			const cached = Math.min(toPositiveInt(last.cached_input_tokens), input);
			const tokens: TokenTotals = {
				inputTokens: Math.max(
					0,
					input - cached - toPositiveInt(last.cache_write_input_tokens),
				),
				outputTokens: toPositiveInt(last.output_tokens),
				cacheReadTokens: cached,
				cacheWriteTokens: toPositiveInt(last.cache_write_input_tokens),
				reasoningTokens: Math.min(
					toPositiveInt(last.output_tokens),
					toPositiveInt(last.reasoning_output_tokens),
				),
			};
			if (totalTokens(tokens) === 0) continue;
			const pricing = lookupPricing(state.model);
			const costUsd = pricing
				? calculateCostUsd(
						{
							...tokens,
							cacheWrite5mTokens: tokens.cacheWriteTokens,
							cacheWrite1hTokens: 0,
						},
						pricing,
					)
				: 0;
			recordUsage(
				accumulator,
				state.model,
				tokens,
				costUsd,
				pricing ? calculateCacheSavingsUsd(tokens.cacheReadTokens, pricing) : 0,
				!!pricing,
				timestamp,
				state.sessionId,
			);
		}
	}

	return finalizeProvider(
		"codex",
		accumulator,
		allFiles.length > 0,
		latestLimits?.windows ?? [],
	);
}

function finalizeProvider(
	provider: TokenUsageProvider,
	accumulator: ProviderAccumulator,
	available: boolean,
	windows: TokenUsageWindow[],
): ProviderTokenUsageSnapshot {
	const models = [...accumulator.models.entries()]
		.map(
			([model, bucket]): TokenUsageModel => ({
				model,
				...bucket,
				totalTokens: totalTokens(bucket),
			}),
		)
		.sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
	const tokens = models.reduce<TokenTotals>(
		(totals, model) => ({
			inputTokens: totals.inputTokens + model.inputTokens,
			outputTokens: totals.outputTokens + model.outputTokens,
			cacheReadTokens: totals.cacheReadTokens + model.cacheReadTokens,
			cacheWriteTokens: totals.cacheWriteTokens + model.cacheWriteTokens,
			reasoningTokens: totals.reasoningTokens + model.reasoningTokens,
		}),
		emptyTokens(),
	);
	const days = [...accumulator.days.entries()]
		.map(([day, totals]) => ({ day, ...totals }))
		.sort((a, b) => b.day.localeCompare(a.day));
	return {
		provider,
		available,
		windows,
		costUsd: models.reduce((sum, model) => sum + model.costUsd, 0),
		cacheSavingsUsd: accumulator.cacheSavingsUsd,
		totalTokens: totalTokens(tokens),
		tokens,
		messages: models.reduce((sum, model) => sum + model.messages, 0),
		sessions: accumulator.sessions.size,
		activeDays: accumulator.activeDays.size,
		models,
		days,
		latestActivityAt: accumulator.latestActivityAt,
	};
}

export async function collectTokenUsageSnapshot({
	codexRoot: codexRootOverride,
	claudeRoot: claudeRootOverride,
	nowMs = Date.now(),
}: {
	codexRoot?: string;
	claudeRoot?: string;
	nowMs?: number;
} = {}): Promise<TokenUsageSnapshot> {
	const hostHome = homedir();
	const codexRoot =
		codexRootOverride ??
		join(process.env.CODEX_HOME ?? join(hostHome, ".codex"), "sessions");
	const claudeRoot =
		claudeRootOverride ??
		process.env.CLAUDE_CONFIG_DIR ??
		join(hostHome, ".claude");
	const codexFiles = await listTranscriptFiles(codexRoot);
	const latestLimits = await findLatestCodexLimits(codexFiles);
	const period = resolveRollingPeriod(nowMs);
	const [codex, claude] = await Promise.all([
		scanCodex(codexFiles, period, latestLimits),
		scanClaude(claudeRoot, period),
	]);
	return {
		providers: [codex, claude],
		period,
		collectedAt: Date.now(),
	};
}

function emptySnapshot(): TokenUsageSnapshot {
	return {
		providers: [
			finalizeProvider("codex", newAccumulator(), false, []),
			finalizeProvider("claude", newAccumulator(), false, []),
		],
		period: resolveRollingPeriod(Date.now()),
		collectedAt: Date.now(),
	};
}

/** Reads and aggregates local Codex and Claude transcripts. */
export async function getTokenUsageSnapshot({
	force = false,
}: {
	force?: boolean;
} = {}): Promise<TokenUsageSnapshot> {
	if (!force && cachedSnapshot && Date.now() < cacheExpiresAt) {
		return cachedSnapshot;
	}
	try {
		cachedSnapshot = await collectTokenUsageSnapshot();
	} catch {
		cachedSnapshot = emptySnapshot();
	}
	cacheExpiresAt = Date.now() + CACHE_TTL_MS;
	return cachedSnapshot;
}
