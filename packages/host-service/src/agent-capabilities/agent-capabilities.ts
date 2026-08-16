import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CopilotClient, type ModelInfo } from "@github/copilot-sdk";
import {
	collectProcessTree,
	readProcessTableAsync,
} from "@superset/pty-daemon/process-tree";
import {
	type AgentCapabilityTrait,
	type AgentModelOption,
	getAgentModelSupport,
} from "@superset/shared/agent-models";
import { z } from "zod";
import {
	getTerminalBaseEnv,
	stripTerminalRuntimeEnv,
	waitForTerminalBaseEnv,
} from "../terminal/env";
import {
	type AgentExecutableSource,
	resolveAgentExecutable,
} from "./executable-resolver";

export type AgentCapabilityStatus =
	| "ready"
	| "unavailable"
	| "authentication_required";

export type AgentModelSource = "runtime" | "fallback" | "none";
export type AgentCapabilityErrorKind =
	| "timeout"
	| "process_failure"
	| "parse_failure"
	| "missing_executable";

export interface AgentCapabilityModel {
	id: string;
	label: string;
	provider?: string;
	reasoning: AgentCapabilityTrait<AgentModelOption>;
}

export interface AgentCapabilitySnapshot {
	agentId: string;
	presetId: string;
	status: AgentCapabilityStatus;
	installed: boolean;
	auth: "authenticated" | "unauthenticated" | "unknown";
	version: string | null;
	modelSource: AgentModelSource;
	models: AgentCapabilityModel[];
	message: string | null;
	checkedAt: string;
	resolverSource?: AgentExecutableSource | null;
	errorKind?: AgentCapabilityErrorKind | null;
	inventoryCheckedAt?: string | null;
	inventoryOrigin?: "live" | "persisted" | "none";
	healthOrigin?: "live" | "persisted";
}

export interface AgentCapabilityConfig {
	id: string;
	presetId: string;
	command: string;
	env: Record<string, string>;
	configRevision?: number;
}

interface CommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

function classifyCommandFailure(
	result: CommandResult,
): AgentCapabilityErrorKind {
	if (result.timedOut) return "timeout";
	if (result.exitCode === 0) return "parse_failure";
	return "process_failure";
}

export class AgentCapabilityProbeAbortedError extends Error {
	constructor() {
		super("Agent capability probe was cancelled");
		this.name = "AgentCapabilityProbeAbortedError";
	}
}

const PROBE_TIMEOUT_MS = 4_000;
const MAX_OUTPUT_LENGTH = 1024 * 1024;
const AUTH_DEPENDENT_PRESETS = new Set([
	"amp",
	"antigravity",
	"claude",
	"codex",
	"copilot",
	"cursor-agent",
	"droid",
	"gemini",
	"grok",
	"kimi",
	"mastracode",
	"opencode",
	"pi",
	"polygraph",
	"vibe",
]);
const PROBE_GRACE_PERIOD_MS = 250;
const PROBE_KILL_SAFETY_MS = 500;
const nodeErrorSchema = z.object({ code: z.string() }).passthrough();

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const parsed = nodeErrorSchema.safeParse(error);
		return parsed.success && parsed.data.code === "EPERM";
	}
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Already gone, or not signalable.
	}
}

function signalKnownPids(
	knownPids: Iterable<number>,
	signal: NodeJS.Signals,
): void {
	for (const pid of knownPids) signalPid(pid, signal);
}

async function expandProcessTree(knownPids: Set<number>): Promise<void> {
	if (knownPids.size === 0) return;
	const table = await readProcessTableAsync();
	if (!table) return;
	for (const root of [...knownPids]) {
		for (const pid of collectProcessTree(root, table)) {
			knownPids.add(pid);
		}
	}
}

export function runCommand(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	timeoutMs = PROBE_TIMEOUT_MS,
	input?: string,
	completeWhenStdout?: (stdout: string) => boolean,
	signal?: AbortSignal,
	gracePeriodMs = PROBE_GRACE_PERIOD_MS,
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env,
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});

		if (input !== undefined) child.stdin?.end(input);

		let stdout = "";
		let stderr = "";
		let settled = false;
		let childClosed = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let safetyTimer: ReturnType<typeof setTimeout> | undefined;

		const closeWaiters: Array<() => void> = [];

		const markClosed = () => {
			if (childClosed) return;
			childClosed = true;
			for (const waiter of closeWaiters) waiter();
			closeWaiters.length = 0;
		};

		// `close` is the reap/stdio-drain boundary. `exit` can fire while
		// buffered output is still in flight. Spawn failure has no process.
		child.on("close", markClosed);
		child.on("error", markClosed);

		const waitForCloseOrTimeout = (
			ms: number,
			assignTimer: (timer: ReturnType<typeof setTimeout>) => void,
		): Promise<"closed" | "timeout"> => {
			if (childClosed) return Promise.resolve("closed");
			return new Promise((resolveWait) => {
				const timer = setTimeout(() => resolveWait("timeout"), ms);
				timer.unref?.();
				assignTimer(timer);
				closeWaiters.push(() => {
					clearTimeout(timer);
					resolveWait("closed");
				});
				if (childClosed) {
					clearTimeout(timer);
					resolveWait("closed");
				}
			});
		};

		const clearAssignedTimer = (
			timer: ReturnType<typeof setTimeout> | undefined,
		) => {
			if (timer) clearTimeout(timer);
		};

		const cleanupTimersAndListeners = () => {
			clearAssignedTimer(timeoutTimer);
			clearAssignedTimer(graceTimer);
			clearAssignedTimer(safetyTimer);
			timeoutTimer = undefined;
			graceTimer = undefined;
			safetyTimer = undefined;
			signal?.removeEventListener("abort", handleAbort);
		};

		const killChildAndAwaitTermination = async (): Promise<void> => {
			const rootPid = child.pid;
			const knownPids = new Set<number>();
			if (rootPid) knownPids.add(rootPid);

			if (process.platform === "win32") {
				try {
					child.kill();
				} catch {
					// Already gone.
				}
				await waitForCloseOrTimeout(PROBE_KILL_SAFETY_MS, (timer) => {
					safetyTimer = timer;
				});
				clearAssignedTimer(safetyTimer);
				safetyTimer = undefined;
				return;
			}

			await expandProcessTree(knownPids);
			signalKnownPids(knownPids, "SIGTERM");
			try {
				child.kill("SIGTERM");
			} catch {
				// Already gone.
			}

			await waitForCloseOrTimeout(gracePeriodMs, (timer) => {
				graceTimer = timer;
			});
			clearAssignedTimer(graceTimer);
			graceTimer = undefined;

			await expandProcessTree(knownPids);
			signalKnownPids([...knownPids].filter(isPidAlive), "SIGKILL");
			try {
				child.kill("SIGKILL");
			} catch {
				// Already gone.
			}

			if (!childClosed) {
				await waitForCloseOrTimeout(PROBE_KILL_SAFETY_MS, (timer) => {
					safetyTimer = timer;
				});
				clearAssignedTimer(safetyTimer);
				safetyTimer = undefined;
			}

			signalKnownPids([...knownPids].filter(isPidAlive), "SIGKILL");
		};

		const finishNatural = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			cleanupTimersAndListeners();
			resolve({ exitCode, stdout, stderr, timedOut: false });
		};

		const finishWithKill = async (partial: {
			exitCode: number | null;
			timedOut: boolean;
		}) => {
			if (settled) return;
			settled = true;
			cleanupTimersAndListeners();
			try {
				await killChildAndAwaitTermination();
			} catch {
				// Settlement must stay bounded if termination helpers fail.
			}
			resolve({
				exitCode: partial.exitCode,
				stdout,
				stderr,
				timedOut: partial.timedOut,
			});
		};

		const handleAbort = () => {
			if (settled) return;
			settled = true;
			cleanupTimersAndListeners();
			void (async () => {
				try {
					await killChildAndAwaitTermination();
				} catch {
					// Settlement must stay bounded if termination helpers fail.
				}
				reject(new AgentCapabilityProbeAbortedError());
			})();
		};

		const append = (current: string, chunk: Buffer) =>
			(current + chunk.toString()).slice(-MAX_OUTPUT_LENGTH);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
			if (!settled && completeWhenStdout?.(stdout)) {
				void finishWithKill({ exitCode: 0, timedOut: false });
			}
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});

		child.on("error", () => {
			finishNatural(null);
		});

		child.on("close", (exitCode) => {
			finishNatural(exitCode);
		});

		timeoutTimer = setTimeout(() => {
			void finishWithKill({ exitCode: null, timedOut: true });
		}, timeoutMs);

		signal?.addEventListener("abort", handleAbort, { once: true });
		if (signal?.aborted) {
			handleAbort();
		}
	});
}

async function createProbeEnvironment(configEnv: Record<string, string>) {
	await waitForTerminalBaseEnv();
	let baseEnv: Record<string, string>;
	try {
		baseEnv = getTerminalBaseEnv();
	} catch {
		// Unit tests and standalone host helpers may not initialize the shell
		// snapshot. Keep their fallback free from desktop/runtime variables too.
		baseEnv = stripTerminalRuntimeEnv(
			Object.fromEntries(
				Object.entries(process.env).filter(
					(entry): entry is [string, string] => entry[1] !== undefined,
				),
			),
		);
	}
	const probeEnv = {
		...baseEnv,
		// The login-shell snapshot can inherit temporary Codex/npm shims that
		// make OpenCode spend tens of seconds initializing plugins. The host's
		// PATH has already been assembled for this machine and resolves the same
		// user CLI without those transient prefixes.
		...configEnv,
	};
	if (process.env.PATH) probeEnv.PATH = process.env.PATH;
	return probeEnv;
}

async function probeAuthentication(
	presetId: string,
	executable: string,
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<AgentCapabilitySnapshot["auth"]> {
	let args: string[] | undefined;
	switch (presetId) {
		case "amp":
			args = ["config", "model-providers", "list", "--no-color"];
			break;
		case "claude":
			args = ["auth", "status", "--json"];
			break;
		case "codex":
			args = ["login", "status"];
			break;
		case "polygraph":
			args = ["whoami", "--json"];
			break;
	}
	if (!args) return "unknown";
	const result = await runCommand(
		executable,
		args,
		env,
		PROBE_TIMEOUT_MS,
		undefined,
		undefined,
		signal,
	);
	const output = `${result.stdout}\n${result.stderr}`;
	if (
		result.exitCode === 0 &&
		(/"loggedIn"\s*:\s*true/i.test(output) || /logged in/i.test(output))
	) {
		return "authenticated";
	}
	if (
		/"loggedIn"\s*:\s*false|"success"\s*:\s*false[^\n]*"type"\s*:\s*"auth"|not logged in|authentication required|invalid or missing api key|run .*login/i.test(
			output,
		)
	) {
		return "unauthenticated";
	}
	return "unknown";
}

function titleFromModelId(id: string): string {
	const model = id.split("/").at(-1) ?? id;
	const title = model
		.split("-")
		.filter(Boolean)
		.map((part) => {
			if (/^\d+(?:\.\d+)*$/.test(part)) return part;
			if (/^(gpt|ai|oss|v\d+)$/i.test(part)) return part.toUpperCase();
			return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
		})
		.join(" ");
	if (title === "Xhigh") return "Extra High";
	return title.replace(/^GPT (?=\d)/, "GPT-");
}

export function parseLineModels(output: string): AgentCapabilityModel[] {
	const seen = new Set<string>();
	const models: AgentCapabilityModel[] = [];
	for (const rawLine of output.split(/\r?\n/)) {
		const id = rawLine.trim().split(/\s+/)[0];
		if (!id || id.startsWith("Error:") || seen.has(id)) continue;
		seen.add(id);
		models.push({
			id,
			label: titleFromModelId(id),
			reasoning: { state: "unknown" },
		});
	}
	return models;
}

const ANTIGRAVITY_EFFORT_ORDER = ["low", "medium", "high"] as const;

function titleAntigravityModelId(id: string): string {
	return titleFromModelId(id.replace(/-(\d+)-(\d+)(?=-|$)/g, "-$1.$2"));
}

export function parseAntigravityModels(output: string): AgentCapabilityModel[] {
	const discovered = parseLineModels(output);
	const variantsByBaseId = new Map<
		string,
		Array<{ model: AgentCapabilityModel; effort: string }>
	>();
	const baseIdByModelId = new Map<string, string>();

	for (const model of discovered) {
		const match = model.id.match(/^(.*)-(low|medium|high)$/);
		if (!match?.[1] || !match[2]) continue;
		const baseId = match[1];
		baseIdByModelId.set(model.id, baseId);
		const variants = variantsByBaseId.get(baseId) ?? [];
		variants.push({ model, effort: match[2] });
		variantsByBaseId.set(baseId, variants);
	}

	const emittedBaseIds = new Set<string>();
	return discovered.flatMap((model): AgentCapabilityModel[] => {
		const baseId = baseIdByModelId.get(model.id);
		if (!baseId)
			return [
				{
					...model,
					label: titleAntigravityModelId(model.id),
					reasoning: { state: "unsupported" },
				},
			];
		const variants = variantsByBaseId.get(baseId) ?? [];
		if (variants.length < 2) {
			return [{ ...model, label: titleAntigravityModelId(model.id) }];
		}
		if (emittedBaseIds.has(baseId)) return [];
		emittedBaseIds.add(baseId);

		const efforts = ANTIGRAVITY_EFFORT_ORDER.filter((effort) =>
			variants.some((variant) => variant.effort === effort),
		).map((effort) => ({ id: effort, label: titleFromModelId(effort) }));
		const defaultVariant =
			variants.find((variant) => variant.effort === "high") ?? variants[0];
		if (!defaultVariant) return [];

		return [
			{
				id: defaultVariant.model.id,
				label: titleAntigravityModelId(baseId),
				reasoning: {
					state: "supported",
					defaultId: defaultVariant.effort,
					options: efforts,
				},
			},
		];
	});
}

export function parseGrokModels(output: string): AgentCapabilityModel[] {
	return output.split(/\r?\n/).flatMap((rawLine) => {
		const match = rawLine.match(
			/^\s*(?:\*|-)\s+([^\s(]+)(?:\s+\(default\))?\s*$/,
		);
		if (!match?.[1]) return [];
		return [
			{
				id: match[1],
				label: titleFromModelId(match[1]),
				reasoning: { state: "unknown" },
			},
		];
	});
}

export function parseKimiProviderModels(
	output: string,
): AgentCapabilityModel[] | null {
	let decoded: z.infer<typeof kimiProviderResponseSchema>;
	try {
		const parsed = kimiProviderResponseSchema.safeParse(JSON.parse(output));
		if (!parsed.success) return null;
		decoded = parsed.data;
	} catch {
		return null;
	}
	const models = kimiProviderModelsSchema.safeParse(decoded.models);
	if (!models.success) return [];
	return Object.entries(models.data).map(([id, model]) => {
		const label = model?.label ?? model?.name ?? titleFromModelId(id);
		const capability: AgentCapabilityModel = {
			id,
			label,
			reasoning: { state: "unknown" },
		};
		if (model?.provider) capability.provider = labelProvider(model.provider);
		return capability;
	});
}

export function parsePiModels(output: string): AgentCapabilityModel[] {
	return output.split(/\r?\n/).flatMap((rawLine) => {
		const fields = rawLine.trim().split(/\s+/);
		const provider = fields[0];
		const model = fields[1];
		if (!provider || !model || provider === "provider") return [];
		return [
			{
				id: `${provider}/${model}`,
				label: titleFromModelId(model),
				provider: labelProvider(provider),
				reasoning: { state: "unknown" },
			},
		];
	});
}

const kimiProviderModelSchema = z
	.object({
		name: z.string().optional().catch(undefined),
		label: z.string().optional().catch(undefined),
		provider: z.string().optional().catch(undefined),
	})
	.passthrough()
	.nullable()
	.catch(null);
const kimiProviderModelsSchema = z.record(z.string(), kimiProviderModelSchema);
const kimiProviderResponseSchema = z
	.object({
		models: z.json().optional(),
	})
	.passthrough();

const piRpcModelSchema = z
	.object({
		id: z.string(),
		name: z.string().optional(),
		provider: z.string(),
		reasoning: z.boolean().optional(),
		thinkingLevelMap: z.record(z.string(), z.json()).optional(),
	})
	.passthrough();
type PiRpcModel = z.infer<typeof piRpcModelSchema>;
const piRpcResponseSchema = z
	.object({
		type: z.literal("response"),
		command: z.literal("get_available_models"),
		success: z.literal(true),
		data: z.object({ models: z.array(z.json()) }).passthrough(),
	})
	.passthrough();

function getPiReasoning(
	model: PiRpcModel,
): AgentCapabilityTrait<AgentModelOption> {
	if (model.reasoning === false) return { state: "unsupported" };
	if (model.reasoning !== true) return { state: "unknown" };
	const map = model.thinkingLevelMap ?? {};
	const standard = ["off", "minimal", "low", "medium", "high"].filter(
		(level) => map[level] !== null,
	);
	const advanced = ["xhigh", "max"].filter(
		(level) => Object.hasOwn(map, level) && map[level] !== null,
	);
	return {
		state: "supported",
		options: [...standard, ...advanced].map((effort) => ({
			id: effort,
			label: titleFromModelId(effort),
		})),
	};
}

export function parsePiRpcModels(output: string): AgentCapabilityModel[] {
	for (const rawLine of output.split(/\r?\n/)) {
		let decoded: z.infer<typeof piRpcResponseSchema>;
		try {
			const response = piRpcResponseSchema.safeParse(JSON.parse(rawLine));
			if (!response.success) continue;
			decoded = response.data;
		} catch {
			continue;
		}
		return decoded.data.models.flatMap((raw): AgentCapabilityModel[] => {
			const parsed = piRpcModelSchema.safeParse(raw);
			if (!parsed.success) return [];
			const model = parsed.data;
			return [
				{
					id: `${model.provider}/${model.id}`,
					label: model.name || titleFromModelId(model.id),
					provider: labelProvider(model.provider),
					reasoning: getPiReasoning(model),
				},
			];
		});
	}
	return [];
}

const openCodeMetadataSchema = z
	.object({
		name: z.string().optional().catch(undefined),
		providerID: z.string().optional().catch(undefined),
		variants: z.record(z.string(), z.json()).optional().catch(undefined),
	})
	.passthrough();
type OpenCodeCliModelMetadata = z.infer<typeof openCodeMetadataSchema>;

function labelProvider(providerId: string): string {
	switch (providerId) {
		case "anthropic":
			return "Anthropic";
		case "opencode":
			return "OpenCode";
		case "openai":
			return "OpenAI";
		case "openai-codex":
			return "OpenAI Codex";
		case "openrouter":
			return "OpenRouter";
		default:
			return titleFromModelId(providerId);
	}
}

/**
 * OpenCode's verbose inventory prints a provider/model slug followed by its
 * JSON metadata. Keep the exact CLI name instead of rebuilding a lossy label
 * from the slug. Plain slug-only output remains supported for older versions.
 */
export function parseOpenCodeModels(output: string): AgentCapabilityModel[] {
	const models: AgentCapabilityModel[] = [];
	const seen = new Set<string>();
	let currentSlug: string | null = null;
	const metadataLines: string[] = [];
	const flush = () => {
		if (!currentSlug || seen.has(currentSlug)) {
			currentSlug = null;
			metadataLines.length = 0;
			return;
		}
		let metadata: OpenCodeCliModelMetadata | null = null;
		try {
			const parsed = openCodeMetadataSchema.safeParse(
				JSON.parse(metadataLines.join("\n")),
			);
			if (parsed.success) metadata = parsed.data;
		} catch {
			// Older OpenCode releases emit only slugs.
		}
		seen.add(currentSlug);
		const variantIds = metadata?.variants
			? Object.keys(metadata.variants)
			: null;
		let reasoning: AgentCapabilityTrait<AgentModelOption> = {
			state: "unknown",
		};
		if (metadata) reasoning = { state: "unsupported" };
		if (variantIds?.length) {
			reasoning = {
				state: "supported",
				options: variantIds.map((id) => ({
					id,
					label: titleFromModelId(id),
				})),
			};
		}
		models.push({
			id: currentSlug,
			label: metadata?.name?.trim() || titleFromModelId(currentSlug),
			provider: labelProvider(
				metadata?.providerID ?? currentSlug.split("/")[0] ?? currentSlug,
			),
			reasoning,
		});
		currentSlug = null;
		metadataLines.length = 0;
	};

	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		const isSlug = !line.startsWith("{") && /^\S+\/\S+$/.test(line);
		if (isSlug) {
			flush();
			currentSlug = line;
		} else if (currentSlug) {
			metadataLines.push(rawLine);
		}
	}
	flush();
	return models;
}

export function mapCopilotModels(
	models: Pick<
		ModelInfo,
		"id" | "name" | "supportedReasoningEfforts" | "defaultReasoningEffort"
	>[],
): AgentCapabilityModel[] {
	return models.map((model) => ({
		id: model.id,
		label: model.name,
		reasoning: copilotModelReasoning(model),
	}));
}

function copilotModelReasoning(
	model: Pick<
		ModelInfo,
		"supportedReasoningEfforts" | "defaultReasoningEffort"
	>,
): AgentCapabilityTrait<AgentModelOption> {
	if (!Array.isArray(model.supportedReasoningEfforts)) {
		return { state: "unknown" };
	}
	if (model.supportedReasoningEfforts.length === 0) {
		return { state: "unsupported" };
	}
	const reasoning: AgentCapabilityTrait<AgentModelOption> = {
		state: "supported",
		options: model.supportedReasoningEfforts.map((effort) => ({
			id: effort,
			label: titleFromModelId(effort),
		})),
	};
	if (model.defaultReasoningEffort) {
		reasoning.defaultId = model.defaultReasoningEffort;
	}
	return reasoning;
}

async function discoverCopilotModels(env: NodeJS.ProcessEnv): Promise<{
	models: AgentCapabilityModel[];
	auth: AgentCapabilitySnapshot["auth"];
	message: string | null;
	errorKind: AgentCapabilityErrorKind | null;
}> {
	const client = new CopilotClient({ env, logLevel: "none" });
	try {
		await client.start();
		const auth = await client.getAuthStatus();
		if (!auth.isAuthenticated) {
			return {
				models: [],
				auth: "unauthenticated",
				message: "Authentication required",
				errorKind: null,
			};
		}
		return {
			models: mapCopilotModels(await client.listModels()),
			auth: "authenticated",
			message: null,
			errorKind: null,
		};
	} catch {
		return {
			models: [],
			auth: "unknown",
			message: "Could not query models from the Copilot runtime",
			errorKind: "process_failure",
		};
	} finally {
		await client.stop().catch(() => client.forceStop());
	}
}

const codexReasoningLevelSchema = z
	.object({ effort: z.string() })
	.passthrough();
const codexCacheModelSchema = z
	.object({
		slug: z.string().min(1),
		display_name: z.string().optional().catch(undefined),
		visibility: z.string().optional().catch(undefined),
		upgrade: z.json().optional().catch(undefined),
		default_reasoning_level: z.string().optional().catch(undefined),
		supported_reasoning_levels: z.array(z.json()).optional().catch(undefined),
	})
	.passthrough();
type CodexCacheModel = z.infer<typeof codexCacheModelSchema>;
const codexModelsCacheSchema = z
	.object({ models: z.array(z.json()) })
	.passthrough();

function codexModelReasoning(
	model: CodexCacheModel,
	efforts: AgentModelOption[],
): AgentCapabilityTrait<AgentModelOption> {
	if (!model.supported_reasoning_levels) return { state: "unknown" };
	if (efforts.length === 0) return { state: "unsupported" };
	const reasoning: AgentCapabilityTrait<AgentModelOption> = {
		state: "supported",
		options: efforts,
	};
	if (model.default_reasoning_level) {
		reasoning.defaultId = model.default_reasoning_level;
	}
	return reasoning;
}

export function parseCodexModelsCache(input: string): AgentCapabilityModel[] {
	let decoded: z.infer<typeof codexModelsCacheSchema>;
	try {
		const parsed = codexModelsCacheSchema.safeParse(JSON.parse(input));
		if (!parsed.success) return [];
		decoded = parsed.data;
	} catch {
		return [];
	}
	return decoded.models.flatMap((raw): AgentCapabilityModel[] => {
		const parsed = codexCacheModelSchema.safeParse(raw);
		if (!parsed.success) return [];
		const model = parsed.data;
		// The cache also contains internal routing aliases such as Work Mode.
		// Codex's own model/list response omits entries marked hidden, so mirror
		// that contract instead of leaking implementation-only models into UI.
		if (model.visibility === "hide") return [];
		const efforts = Array.isArray(model.supported_reasoning_levels)
			? model.supported_reasoning_levels.flatMap(
					(level): Array<{ id: string; label: string }> => {
						const parsedLevel = codexReasoningLevelSchema.safeParse(level);
						if (!parsedLevel.success) return [];
						const { effort } = parsedLevel.data;
						return [{ id: effort, label: titleFromModelId(effort) }];
					},
				)
			: [];
		if (
			Array.isArray(model.supported_reasoning_levels) &&
			model.supported_reasoning_levels.length > 0 &&
			efforts.length === 0
		) {
			return [];
		}
		return [
			{
				id: model.slug,
				label: titleFromModelId(model.display_name || model.slug),
				provider:
					model.upgrade !== null && model.upgrade !== undefined
						? "Legacy Models"
						: "Current Models",
				reasoning: codexModelReasoning(model, efforts),
			},
		];
	});
}

function fallbackModels(presetId: string): AgentCapabilityModel[] {
	return (getAgentModelSupport(presetId)?.models ?? []).map((model) => ({
		...model,
		reasoning: { state: "unknown" },
	}));
}

function mergeAuthenticationObservations(
	discovered: AgentCapabilitySnapshot["auth"],
	probed: AgentCapabilitySnapshot["auth"],
): AgentCapabilitySnapshot["auth"] {
	if (discovered === "unauthenticated" || probed === "unauthenticated") {
		return "unauthenticated";
	}
	if (discovered === "authenticated" || probed === "authenticated") {
		return "authenticated";
	}
	return "unknown";
}

function capabilityStatusForAuth(
	auth: AgentCapabilitySnapshot["auth"],
	presetId: string,
): AgentCapabilityStatus {
	if (auth === "unauthenticated") return "authentication_required";
	if (auth === "unknown" && AUTH_DEPENDENT_PRESETS.has(presetId)) {
		return "unavailable";
	}
	return "ready";
}

async function discoverModels(
	config: AgentCapabilityConfig,
	executable: string,
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<{
	models: AgentCapabilityModel[];
	source: AgentModelSource;
	auth: AgentCapabilitySnapshot["auth"];
	message: string | null;
	errorKind: AgentCapabilityErrorKind | null;
}> {
	let lastErrorKind: AgentCapabilityErrorKind | null = null;
	if (config.presetId === "antigravity") {
		const result = await runCommand(
			executable,
			["models"],
			env,
			PROBE_TIMEOUT_MS,
			undefined,
			undefined,
			signal,
		);
		const models = parseAntigravityModels(result.stdout);
		const output = `${result.stdout}\n${result.stderr}`;
		if (
			/not authenticated|authentication required|sign in|log in|logged out/i.test(
				output,
			)
		) {
			return {
				models: [],
				source: "none",
				auth: "unauthenticated",
				message: "Authentication required",
				errorKind: null,
			};
		}
		if (result.exitCode === 0 && models.length > 0) {
			return {
				models,
				source: "runtime",
				auth: "authenticated",
				message: null,
				errorKind: null,
			};
		}
		return {
			models: [],
			source: "none",
			auth: "unknown",
			message: "Could not query models from the Antigravity runtime",
			errorKind: classifyCommandFailure(result),
		};
	}

	if (config.presetId === "copilot") {
		const discovery = await discoverCopilotModels(env);
		return {
			...discovery,
			source: discovery.models.length > 0 ? "runtime" : "none",
		};
	}

	if (config.presetId === "codex") {
		const cachePath = join(
			env.CODEX_HOME ?? join(homedir(), ".codex"),
			"models_cache.json",
		);
		try {
			const models = parseCodexModelsCache(await readFile(cachePath, "utf8"));
			if (models.length > 0) {
				return {
					models,
					source: "runtime",
					auth: "authenticated",
					message: null,
					errorKind: null,
				};
			}
		} catch {
			// Fall through to the catalog bundled for this CLI family.
		}
	}

	if (config.presetId === "pi") {
		let result = await runCommand(
			executable,
			// Extensions are useful in interactive sessions but can initialize
			// arbitrary user code before the RPC server begins accepting requests.
			// Discovery only needs Pi's configured model registry.
			["--mode", "rpc", "--no-session", "--no-extensions"],
			env,
			PROBE_TIMEOUT_MS,
			'{"type":"get_available_models"}\n',
			(output) => parsePiRpcModels(output).length > 0,
			signal,
		);
		let models = parsePiRpcModels(result.stdout);
		if (!result.timedOut && (result.exitCode !== 0 || models.length === 0)) {
			result = await runCommand(
				executable,
				["--list-models"],
				env,
				PROBE_TIMEOUT_MS,
				undefined,
				undefined,
				signal,
			);
			models = parsePiModels(result.stdout);
		}
		if (result.exitCode === 0 && models.length > 0) {
			return {
				models,
				source: "runtime",
				auth: "authenticated",
				message: null,
				errorKind: null,
			};
		}
		return {
			models: [],
			source: "none",
			auth: "unknown",
			message: "No authenticated Pi models were found",
			errorKind: classifyCommandFailure(result),
		};
	}

	if (config.presetId === "grok") {
		const result = await runCommand(
			executable,
			["models"],
			env,
			PROBE_TIMEOUT_MS,
			undefined,
			undefined,
			signal,
		);
		const models = parseGrokModels(result.stdout);
		const output = `${result.stdout}\n${result.stderr}`;
		if (/not logged in|authentication required|run .*login/i.test(output)) {
			return {
				models: [],
				source: "none",
				auth: "unauthenticated",
				message: "Authentication required",
				errorKind: null,
			};
		}
		if (result.exitCode === 0 && models.length > 0) {
			return {
				models,
				source: "runtime",
				auth: "authenticated",
				message: null,
				errorKind: null,
			};
		}
		return {
			models: [],
			source: "none",
			auth: "unknown",
			message: "Could not query models from the Grok runtime",
			errorKind: classifyCommandFailure(result),
		};
	}

	if (config.presetId === "kimi") {
		const result = await runCommand(
			executable,
			["provider", "list", "--json"],
			env,
			PROBE_TIMEOUT_MS,
			undefined,
			undefined,
			signal,
		);
		const models = parseKimiProviderModels(result.stdout);
		if (result.exitCode === 0 && models?.length) {
			return {
				models,
				source: "runtime",
				auth: "authenticated",
				message: null,
				errorKind: null,
			};
		}
		if (result.exitCode === 0 && models) {
			return {
				models: [],
				source: "none",
				auth: "unauthenticated",
				message: "Authentication required",
				errorKind: null,
			};
		}
		return {
			models: [],
			source: "none",
			auth: "unknown",
			message: "Could not query providers from the Kimi runtime",
			errorKind: classifyCommandFailure(result),
		};
	}

	if (config.presetId === "opencode" || config.presetId === "cursor-agent") {
		const args =
			config.presetId === "opencode"
				? ["models", "--verbose"]
				: ["--list-models"];
		let result = await runCommand(
			executable,
			args,
			env,
			PROBE_TIMEOUT_MS,
			undefined,
			undefined,
			signal,
		);
		let models =
			config.presetId === "opencode"
				? parseOpenCodeModels(result.stdout)
				: parseLineModels(result.stdout);
		if (
			config.presetId === "opencode" &&
			(result.exitCode !== 0 || models.length === 0)
		) {
			result = await runCommand(
				executable,
				args,
				env,
				PROBE_TIMEOUT_MS,
				undefined,
				undefined,
				signal,
			);
			models = parseOpenCodeModels(result.stdout);
		}
		const output = `${result.stdout}\n${result.stderr}`;
		if (/authentication required|not authenticated|run .*login/i.test(output)) {
			return {
				models: [],
				source: "none",
				auth: "unauthenticated",
				message: "Authentication required",
				errorKind: null,
			};
		}
		if (result.exitCode === 0 && models.length > 0) {
			return {
				models,
				source: "runtime",
				auth: "authenticated",
				message: null,
				errorKind: null,
			};
		}
		lastErrorKind = classifyCommandFailure(result);
	}

	const models = fallbackModels(config.presetId);
	return {
		models,
		source: models.length > 0 ? "fallback" : "none",
		auth: "unknown",
		message: models.length > 0 ? "Using the versioned fallback catalog" : null,
		errorKind: lastErrorKind,
	};
}

async function probeAgentCapability(
	config: AgentCapabilityConfig,
	now: number,
	signal?: AbortSignal,
): Promise<AgentCapabilitySnapshot> {
	const env = await createProbeEnvironment(config.env);
	const resolvedExecutable = await resolveAgentExecutable(config.command, env);
	if (!resolvedExecutable) {
		const snapshot: AgentCapabilitySnapshot = {
			agentId: config.id,
			presetId: config.presetId,
			status: "unavailable",
			installed: false,
			auth: "unknown",
			version: null,
			modelSource: "none",
			models: [],
			message: `${config.command} was not found in PATH`,
			checkedAt: new Date(now).toISOString(),
			resolverSource: null,
			errorKind: "missing_executable",
			inventoryCheckedAt: null,
			inventoryOrigin: "none",
			healthOrigin: "live",
		};
		return snapshot;
	}
	const executable = resolvedExecutable.path;

	const shouldProbeVersion = new Set([
		"antigravity",
		"claude",
		"codex",
		"grok",
		"opencode",
		"cursor-agent",
	]).has(config.presetId);
	const [versionResult, discovery, probedAuth] = await Promise.all([
		shouldProbeVersion
			? runCommand(
					executable,
					["--version"],
					env,
					PROBE_TIMEOUT_MS,
					undefined,
					undefined,
					signal,
				)
			: Promise.resolve({
					exitCode: null,
					stdout: "",
					stderr: "",
					timedOut: false,
				}),
		discoverModels(config, executable, env, signal),
		probeAuthentication(config.presetId, executable, env, signal),
	]);
	const versionLine = versionResult.stdout.trim().split(/\r?\n/)[0] || null;
	const auth = mergeAuthenticationObservations(discovery.auth, probedAuth);
	const status = capabilityStatusForAuth(auth, config.presetId);
	const snapshot: AgentCapabilitySnapshot = {
		agentId: config.id,
		presetId: config.presetId,
		status,
		installed: true,
		auth,
		version: versionLine,
		modelSource: discovery.source,
		models: discovery.models,
		message: discovery.message,
		checkedAt: new Date(now).toISOString(),
		resolverSource: resolvedExecutable.source,
		errorKind: discovery.errorKind,
		inventoryCheckedAt:
			discovery.source === "none" ? null : new Date(now).toISOString(),
		inventoryOrigin: discovery.source === "none" ? "none" : "live",
		healthOrigin: "live",
	};
	return snapshot;
}

export function inspectAgentCapability(
	config: AgentCapabilityConfig,
	options: { now?: number; signal?: AbortSignal } = {},
): Promise<AgentCapabilitySnapshot> {
	const now = options.now ?? Date.now();
	return probeAgentCapability(config, now, options.signal);
}
