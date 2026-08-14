import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { CopilotClient, type ModelInfo } from "@github/copilot-sdk";
import { getAgentModelSupport } from "@superset/shared/agent-models";
import {
	getTerminalBaseEnv,
	stripTerminalRuntimeEnv,
	waitForTerminalBaseEnv,
} from "../terminal/env";

export type AgentCapabilityStatus =
	| "ready"
	| "unavailable"
	| "authentication_required";

export type AgentModelSource = "runtime" | "fallback" | "none";

export interface AgentCapabilityModel {
	id: string;
	label: string;
	provider?: string;
	defaultEffortId?: string;
	efforts?: Array<{ id: string; label: string }>;
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
}

export interface AgentCapabilityConfig {
	id: string;
	presetId: string;
	command: string;
	env: Record<string, string>;
}

interface CommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

const PROBE_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 30_000;
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
const capabilityCache = new Map<
	string,
	{ expiresAt: number; snapshot: AgentCapabilitySnapshot }
>();

function cacheKey(config: AgentCapabilityConfig): string {
	return `${config.id}:${config.command}:${JSON.stringify(config.env)}`;
}

async function resolveExecutable(
	command: string,
	env: NodeJS.ProcessEnv,
	options: { preferDirectBinary?: boolean } = {},
): Promise<string | null> {
	const candidates =
		isAbsolute(command) || command.includes("/")
			? [command]
			: (env.PATH ?? "")
					.split(delimiter)
					.filter(Boolean)
					.map((directory) => join(directory, command));
	const executableCandidates: string[] = [];
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			executableCandidates.push(candidate);
		} catch {
			// Keep looking through PATH.
		}
	}
	if (options.preferDirectBinary && executableCandidates.length > 1) {
		for (const candidate of executableCandidates) {
			let handle: Awaited<ReturnType<typeof open>> | null = null;
			try {
				handle = await open(candidate, "r");
				const bytes = Buffer.alloc(2);
				await handle.read(bytes, 0, bytes.length, 0);
				const prefix = bytes.toString();
				if (prefix !== "#!") return candidate;
			} catch {
				// Fall back to normal PATH order when a candidate cannot be inspected.
			} finally {
				await handle?.close();
			}
		}
	}
	if (options.preferDirectBinary) {
		for (const wrapper of executableCandidates) {
			try {
				const source = await readFile(wrapper, "utf8");
				const packageName = source.match(/^package="([^"]+)"$/m)?.[1];
				const binaryName = source.match(/^command="([^"]+)"$/m)?.[1];
				if (!packageName || !binaryName) continue;
				const cacheRoot = join(env.HOME ?? homedir(), ".npm", "_npx");
				for (const entry of await readdir(cacheRoot)) {
					try {
						const packageRoot = join(
							cacheRoot,
							entry,
							"node_modules",
							...packageName.split("/"),
						);
						await access(join(packageRoot, "package.json"), constants.R_OK);
						const candidate = join(
							cacheRoot,
							entry,
							"node_modules",
							".bin",
							binaryName,
						);
						await access(candidate, constants.X_OK);
						return candidate;
					} catch {
						// This npx cache entry belongs to a different package.
					}
				}
			} catch {
				// Not an Omarchy npx wrapper, or its package is not cached yet.
			}
		}
	}
	return executableCandidates[0] ?? null;
}

function runCommand(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	timeoutMs = PROBE_TIMEOUT_MS,
	input?: string,
	completeWhenStdout?: (stdout: string) => boolean,
): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			env,
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		if (input !== undefined) child.stdin?.end(input);
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;
		const finish = (result: CommandResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const append = (current: string, chunk: Buffer) =>
			(current + chunk.toString()).slice(-MAX_OUTPUT_LENGTH);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
			if (completeWhenStdout?.(stdout)) {
				child.kill("SIGTERM");
				finish({ exitCode: 0, stdout, stderr, timedOut: false });
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		child.on("error", () =>
			finish({ exitCode: null, stdout, stderr, timedOut: false }),
		);
		child.on("close", (exitCode) =>
			finish({ exitCode, stdout, stderr, timedOut: false }),
		);
		timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish({ exitCode: null, stdout, stderr, timedOut: true });
		}, timeoutMs);
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
				Object.entries(process.env).flatMap(([key, value]) =>
					typeof value === "string" ? [[key, value]] : [],
				),
			),
		);
	}
	return {
		...baseEnv,
		// The login-shell snapshot can inherit temporary Codex/npm shims that
		// make OpenCode spend tens of seconds initializing plugins. The host's
		// PATH has already been assembled for this machine and resolves the same
		// user CLI without those transient prefixes.
		...(process.env.PATH ? { PATH: process.env.PATH } : {}),
		...configEnv,
	};
}

async function probeAuthentication(
	presetId: string,
	executable: string,
	env: NodeJS.ProcessEnv,
): Promise<AgentCapabilitySnapshot["auth"]> {
	const argsByPreset: Partial<Record<string, string[]>> = {
		amp: ["config", "model-providers", "list", "--no-color"],
		claude: ["auth", "status", "--json"],
		codex: ["login", "status"],
		polygraph: ["whoami", "--json"],
	};
	const args = argsByPreset[presetId];
	if (!args) return "unknown";
	const result = await runCommand(executable, args, env);
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
		models.push({ id, label: titleFromModelId(id) });
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
			return [{ ...model, label: titleAntigravityModelId(model.id) }];
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
				defaultEffortId: defaultVariant.effort,
				efforts,
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
		return [{ id: match[1], label: titleFromModelId(match[1]) }];
	});
}

export function parseKimiProviderModels(
	output: string,
): AgentCapabilityModel[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const models = (parsed as { models?: unknown }).models;
	if (!models || typeof models !== "object" || Array.isArray(models)) return [];
	return Object.entries(models).map(([id, raw]) => {
		const model =
			raw && typeof raw === "object"
				? (raw as {
						name?: unknown;
						label?: unknown;
						provider?: unknown;
					})
				: null;
		const label =
			typeof model?.label === "string"
				? model.label
				: typeof model?.name === "string"
					? model.name
					: titleFromModelId(id);
		return {
			id,
			label,
			...(typeof model?.provider === "string"
				? { provider: labelProvider(model.provider) }
				: {}),
		};
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
			},
		];
	});
}

interface PiRpcModel {
	id?: unknown;
	name?: unknown;
	provider?: unknown;
	reasoning?: unknown;
	thinkingLevelMap?: unknown;
}

function getPiEfforts(model: PiRpcModel): Array<{ id: string; label: string }> {
	if (model.reasoning !== true) return [{ id: "off", label: "Off" }];
	const map =
		model.thinkingLevelMap && typeof model.thinkingLevelMap === "object"
			? (model.thinkingLevelMap as Record<string, unknown>)
			: {};
	const standard = ["off", "minimal", "low", "medium", "high"].filter(
		(level) => map[level] !== null,
	);
	const advanced = ["xhigh", "max"].filter(
		(level) => Object.hasOwn(map, level) && map[level] !== null,
	);
	return [...standard, ...advanced].map((effort) => ({
		id: effort,
		label: titleFromModelId(effort),
	}));
}

export function parsePiRpcModels(output: string): AgentCapabilityModel[] {
	for (const rawLine of output.split(/\r?\n/)) {
		let response: unknown;
		try {
			response = JSON.parse(rawLine);
		} catch {
			continue;
		}
		if (!response || typeof response !== "object") continue;
		const rpc = response as {
			type?: unknown;
			command?: unknown;
			success?: unknown;
			data?: { models?: unknown };
		};
		if (
			rpc.type !== "response" ||
			rpc.command !== "get_available_models" ||
			rpc.success !== true ||
			!Array.isArray(rpc.data?.models)
		) {
			continue;
		}
		return rpc.data.models.flatMap((raw): AgentCapabilityModel[] => {
			if (!raw || typeof raw !== "object") return [];
			const model = raw as PiRpcModel;
			if (typeof model.id !== "string" || typeof model.provider !== "string")
				return [];
			return [
				{
					id: `${model.provider}/${model.id}`,
					label:
						typeof model.name === "string" && model.name
							? model.name
							: titleFromModelId(model.id),
					provider: labelProvider(model.provider),
					efforts: getPiEfforts(model),
				},
			];
		});
	}
	return [];
}

interface OpenCodeCliModelMetadata {
	name?: unknown;
	providerID?: unknown;
	variants?: unknown;
}

function labelProvider(providerId: string): string {
	const labels: Record<string, string> = {
		anthropic: "Anthropic",
		opencode: "OpenCode",
		openai: "OpenAI",
		"openai-codex": "OpenAI Codex",
		openrouter: "OpenRouter",
	};
	return labels[providerId] ?? titleFromModelId(providerId);
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
			metadata = JSON.parse(
				metadataLines.join("\n"),
			) as OpenCodeCliModelMetadata;
		} catch {
			// Older OpenCode releases emit only slugs.
		}
		seen.add(currentSlug);
		const efforts =
			metadata?.variants &&
			typeof metadata.variants === "object" &&
			!Array.isArray(metadata.variants)
				? Object.keys(metadata.variants).map((id) => ({
						id,
						label: titleFromModelId(id),
					}))
				: undefined;
		models.push({
			id: currentSlug,
			label:
				typeof metadata?.name === "string" && metadata.name.trim()
					? metadata.name.trim()
					: titleFromModelId(currentSlug),
			provider: labelProvider(
				typeof metadata?.providerID === "string"
					? metadata.providerID
					: (currentSlug.split("/")[0] ?? currentSlug),
			),
			...(efforts ? { efforts } : {}),
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
		...(model.defaultReasoningEffort
			? { defaultEffortId: model.defaultReasoningEffort }
			: {}),
		// An empty array is authoritative: this authenticated model exposes no
		// reasoning override, so the UI must not fall back to a static catalog.
		efforts: (model.supportedReasoningEfforts ?? []).map((effort) => ({
			id: effort,
			label: titleFromModelId(effort),
		})),
	}));
}

async function discoverCopilotModels(env: NodeJS.ProcessEnv): Promise<{
	models: AgentCapabilityModel[];
	auth: AgentCapabilitySnapshot["auth"];
	message: string | null;
}> {
	const client = new CopilotClient({ env, logLevel: "none" });
	try {
		await client.start();
		const auth = await client.getAuthStatus();
		if (!auth.isAuthenticated) {
			return {
				models: [],
				auth: "unauthenticated",
				message: auth.statusMessage ?? "Authentication required",
			};
		}
		return {
			models: mapCopilotModels(await client.listModels()),
			auth: "authenticated",
			message: null,
		};
	} catch {
		return {
			models: [],
			auth: "unknown",
			message: "Could not query models from the Copilot runtime",
		};
	} finally {
		await client.stop().catch(() => client.forceStop());
	}
}

interface CodexCacheModel {
	slug?: unknown;
	display_name?: unknown;
	visibility?: unknown;
	upgrade?: unknown;
	default_reasoning_level?: unknown;
	supported_reasoning_levels?: unknown;
}

export function parseCodexModelsCache(input: string): AgentCapabilityModel[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object" || !("models" in parsed)) return [];
	const rawModels = (parsed as { models?: unknown }).models;
	if (!Array.isArray(rawModels)) return [];
	return rawModels.flatMap((raw): AgentCapabilityModel[] => {
		if (!raw || typeof raw !== "object") return [];
		const model = raw as CodexCacheModel;
		if (typeof model.slug !== "string" || !model.slug) return [];
		// The cache also contains internal routing aliases such as Work Mode.
		// Codex's own model/list response omits entries marked hidden, so mirror
		// that contract instead of leaking implementation-only models into UI.
		if (model.visibility === "hide") return [];
		const efforts = Array.isArray(model.supported_reasoning_levels)
			? model.supported_reasoning_levels.flatMap(
					(level): Array<{ id: string; label: string }> => {
						if (!level || typeof level !== "object") return [];
						const effort = (level as { effort?: unknown }).effort;
						return typeof effort === "string"
							? [{ id: effort, label: titleFromModelId(effort) }]
							: [];
					},
				)
			: [];
		return [
			{
				id: model.slug,
				label:
					typeof model.display_name === "string" && model.display_name
						? titleFromModelId(model.display_name)
						: titleFromModelId(model.slug),
				provider:
					model.upgrade !== null && model.upgrade !== undefined
						? "Legacy Models"
						: "Current Models",
				...(typeof model.default_reasoning_level === "string"
					? { defaultEffortId: model.default_reasoning_level }
					: {}),
				...(efforts.length > 0 ? { efforts } : {}),
			},
		];
	});
}

function fallbackModels(presetId: string): AgentCapabilityModel[] {
	return (getAgentModelSupport(presetId)?.models ?? []).map((model) => ({
		...model,
	}));
}

async function discoverModels(
	config: AgentCapabilityConfig,
	executable: string,
	env: NodeJS.ProcessEnv,
): Promise<{
	models: AgentCapabilityModel[];
	source: AgentModelSource;
	auth: AgentCapabilitySnapshot["auth"];
	message: string | null;
}> {
	if (config.presetId === "antigravity") {
		const result = await runCommand(executable, ["models"], env);
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
			};
		}
		if (result.exitCode === 0 && models.length > 0) {
			return {
				models,
				source: "runtime",
				auth: "authenticated",
				message: null,
			};
		}
		return {
			models: [],
			source: "none",
			auth: "unknown",
			message: "Could not query models from the Antigravity runtime",
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
				};
			}
		} catch {
			// Fall through to the catalog bundled for this CLI family.
		}
	}

	if (config.presetId === "pi") {
		let result = await runCommand(
			executable,
			["--mode", "rpc", "--no-session"],
			env,
			PROBE_TIMEOUT_MS,
			'{"type":"get_available_models"}\n',
			(output) => parsePiRpcModels(output).length > 0,
		);
		let models = parsePiRpcModels(result.stdout);
		if (!result.timedOut && (result.exitCode !== 0 || models.length === 0)) {
			result = await runCommand(executable, ["--list-models"], env);
			models = parsePiModels(result.stdout);
		}
		if (result.exitCode === 0 && models.length > 0) {
			return {
				models,
				source: "runtime",
				auth: "authenticated",
				message: null,
			};
		}
		return {
			models: [],
			source: "none",
			auth: "unknown",
			message: "No authenticated Pi models were found",
		};
	}

	if (config.presetId === "grok") {
		const result = await runCommand(executable, ["models"], env);
		const models = parseGrokModels(result.stdout);
		const output = `${result.stdout}\n${result.stderr}`;
		if (/not logged in|authentication required|run .*login/i.test(output)) {
			return {
				models: [],
				source: "none",
				auth: "unauthenticated",
				message: "Authentication required",
			};
		}
		if (result.exitCode === 0 && models.length > 0) {
			return {
				models,
				source: "runtime",
				auth: "authenticated",
				message: null,
			};
		}
		return {
			models: [],
			source: "none",
			auth: "unknown",
			message: "Could not query models from the Grok runtime",
		};
	}

	if (config.presetId === "kimi") {
		const result = await runCommand(
			executable,
			["provider", "list", "--json"],
			env,
		);
		const models = parseKimiProviderModels(result.stdout);
		if (result.exitCode === 0 && models?.length) {
			return {
				models,
				source: "runtime",
				auth: "authenticated",
				message: null,
			};
		}
		if (result.exitCode === 0 && models) {
			return {
				models: [],
				source: "none",
				auth: "unauthenticated",
				message: "Authentication required",
			};
		}
		return {
			models: [],
			source: "none",
			auth: "unknown",
			message: "Could not query providers from the Kimi runtime",
		};
	}

	if (config.presetId === "opencode" || config.presetId === "cursor-agent") {
		const args =
			config.presetId === "opencode"
				? ["models", "--verbose"]
				: ["--list-models"];
		let result = await runCommand(executable, args, env);
		let models =
			config.presetId === "opencode"
				? parseOpenCodeModels(result.stdout)
				: parseLineModels(result.stdout);
		if (
			config.presetId === "opencode" &&
			(result.exitCode !== 0 || models.length === 0)
		) {
			result = await runCommand(executable, args, env);
			models = parseOpenCodeModels(result.stdout);
		}
		const output = `${result.stdout}\n${result.stderr}`;
		if (/authentication required|not authenticated|run .*login/i.test(output)) {
			return {
				models: [],
				source: "none",
				auth: "unauthenticated",
				message: "Authentication required",
			};
		}
		if (result.exitCode === 0 && models.length > 0) {
			return {
				models,
				source: "runtime",
				auth: "authenticated",
				message: null,
			};
		}
	}

	const models = fallbackModels(config.presetId);
	return {
		models,
		source: models.length > 0 ? "fallback" : "none",
		auth: "unknown",
		message: models.length > 0 ? "Using the versioned fallback catalog" : null,
	};
}

export async function inspectAgentCapability(
	config: AgentCapabilityConfig,
	options: { force?: boolean; now?: number } = {},
): Promise<AgentCapabilitySnapshot> {
	const now = options.now ?? Date.now();
	const key = cacheKey(config);
	const cached = capabilityCache.get(key);
	if (!options.force && cached && cached.expiresAt > now)
		return cached.snapshot;

	const env = await createProbeEnvironment(config.env);
	const executable = await resolveExecutable(config.command, env, {
		// Package-manager wrappers may perform network update checks before every
		// call. Prefer the installed native OpenCode binary later in PATH when one
		// is present; normal launches can keep using the user's configured wrapper.
		preferDirectBinary:
			config.presetId === "opencode" || config.presetId === "pi",
	});
	if (!executable) {
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
		};
		capabilityCache.set(key, { expiresAt: now + CACHE_TTL_MS, snapshot });
		return snapshot;
	}

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
			? runCommand(executable, ["--version"], env)
			: Promise.resolve({
					exitCode: null,
					stdout: "",
					stderr: "",
					timedOut: false,
				}),
		discoverModels(config, executable, env),
		probeAuthentication(config.presetId, executable, env),
	]);
	const versionLine = versionResult.stdout.trim().split(/\r?\n/)[0] || null;
	const auth =
		discovery.auth === "unauthenticated" || probedAuth === "unauthenticated"
			? "unauthenticated"
			: discovery.auth === "authenticated" || probedAuth === "authenticated"
				? "authenticated"
				: "unknown";
	const status =
		auth === "unauthenticated"
			? "authentication_required"
			: auth === "unknown" && AUTH_DEPENDENT_PRESETS.has(config.presetId)
				? "unavailable"
				: "ready";
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
	};
	capabilityCache.set(key, { expiresAt: now + CACHE_TTL_MS, snapshot });
	return snapshot;
}

export function getCachedAgentCapability(
	config: AgentCapabilityConfig,
	now = Date.now(),
): AgentCapabilitySnapshot | null {
	const cached = capabilityCache.get(cacheKey(config));
	return cached && cached.expiresAt > now ? cached.snapshot : null;
}

export function clearAgentCapabilityCache(): void {
	capabilityCache.clear();
}
