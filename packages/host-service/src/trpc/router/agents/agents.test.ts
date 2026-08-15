import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { getAgentModelSupport } from "@superset/shared/agent-models";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { AgentCapabilitySnapshot } from "../../../agent-capabilities/agent-capabilities";
import { CAPABILITY_LAUNCH_FRESHNESS_MS } from "../../../agent-capabilities/capability-refresh-service";
import type { HostDb } from "../../../db";
import * as schema from "../../../db/schema";
import type { HostServiceContext } from "../../../types";
import {
	AgentLaunchCapabilityError,
	type AgentLaunchSelection,
	agentsRouter,
	buildAgentCommandString,
	buildTerminalAgentLaunch,
	type CapabilityRefresher,
	type ValidatedCapabilityLease,
	validateAgentContextWindowSelection,
	validateAgentEffortSelection,
	validateAgentLaunchSelection,
	validateAgentModeSelection,
	validateAgentResumeSelection,
	validateAgentSpeedSelection,
} from "./agents";

const argvConfig = {
	id: "00000000-0000-0000-0000-000000000001",
	presetId: "claude",
	label: "Claude",
	command: "claude",
	args: ["--dangerously-skip-permissions"],
	promptTransport: "argv" as const,
	promptArgs: [],
	resumeArgs: ["--resume"],
	env: {},
	capabilityRevision: 1,
};

const stdinConfig = {
	id: "00000000-0000-0000-0000-000000000002",
	presetId: "amp",
	label: "Amp",
	command: "amp",
	args: [],
	promptTransport: "stdin" as const,
	promptArgs: [],
	resumeArgs: ["threads", "continue"],
	env: {},
	capabilityRevision: 1,
};

const RANDOM_ID = "test-1234";
const DELIMITER = "SUPERSET_PROMPT_test1234";

describe("buildAgentCommandString", () => {
	it("appends the prompt as a quoted positional (argv transport)", () => {
		// Not the shared "$(cat <<…)" form: the command must parse in non-POSIX
		// shells like fish, which have no heredocs.
		expect(
			buildAgentCommandString(argvConfig, "do the thing", [], {
				randomId: RANDOM_ID,
			}),
		).toBe("'claude' '--dangerously-skip-permissions' 'do the thing'");
	});

	it("inserts model args between base args and the prompt (argv transport)", () => {
		expect(
			buildAgentCommandString(
				argvConfig,
				"do the thing",
				["--model", "sonnet"],
				{
					randomId: RANDOM_ID,
				},
			),
		).toBe(
			"'claude' '--dangerously-skip-permissions' '--model' 'sonnet' 'do the thing'",
		);
	});

	it("inserts model args before the heredoc (stdin transport)", () => {
		expect(
			buildAgentCommandString(
				stdinConfig,
				"do the thing",
				["--model", "sonnet"],
				{
					randomId: RANDOM_ID,
				},
			),
		).toBe(
			`'amp' '--model' 'sonnet' <<'${DELIMITER}'\ndo the thing\n${DELIMITER}`,
		);
	});

	it("shell-quotes hostile model and prompt values", () => {
		expect(
			buildAgentCommandString(
				argvConfig,
				"p'; rm -rf /",
				["--model", "x'; rm -rf /"],
				{
					randomId: RANDOM_ID,
				},
			),
		).toBe(
			"'claude' '--dangerously-skip-permissions' '--model' 'x'\\''; rm -rf /' 'p'\\''; rm -rf /'",
		);
	});

	it("includes promptArgs before the prompt when a prompt is present", () => {
		const config = { ...argvConfig, promptArgs: ["-p"] };
		expect(
			buildAgentCommandString(config, "p", [], { randomId: RANDOM_ID }),
		).toBe("'claude' '--dangerously-skip-permissions' '-p' 'p'");
	});

	it("drops promptArgs and the prompt payload when the prompt sanitizes to empty", () => {
		const config = { ...argvConfig, promptArgs: ["-p"] };
		expect(
			buildAgentCommandString(config, "\x1b\x07", [], { randomId: RANDOM_ID }),
		).toBe("'claude' '--dangerously-skip-permissions'");
		expect(
			buildAgentCommandString(stdinConfig, "", [], { randomId: RANDOM_ID }),
		).toBe("'amp'");
	});

	it("splices resumeArgs and the session id after the base args (promptless resume)", () => {
		expect(
			buildAgentCommandString(argvConfig, "", [], {
				resumeSessionId: "abc-123",
				randomId: RANDOM_ID,
			}),
		).toBe("'claude' '--dangerously-skip-permissions' '--resume' 'abc-123'");
	});

	it("keeps the prompt after the resume args (argv transport)", () => {
		expect(
			buildAgentCommandString(argvConfig, "keep going", ["--model", "sonnet"], {
				resumeSessionId: "abc-123",
				randomId: RANDOM_ID,
			}),
		).toBe(
			"'claude' '--dangerously-skip-permissions' '--model' 'sonnet' '--resume' 'abc-123' 'keep going'",
		);
	});

	it("supports subcommand-style resume args (stdin transport)", () => {
		expect(
			buildAgentCommandString(stdinConfig, "keep going", [], {
				resumeSessionId: "T-42",
				randomId: RANDOM_ID,
			}),
		).toBe(
			`'amp' 'threads' 'continue' 'T-42' <<'${DELIMITER}'\nkeep going\n${DELIMITER}`,
		);
	});

	it("shell-quotes and sanitizes a hostile resume session id", () => {
		expect(
			buildAgentCommandString(argvConfig, "", [], {
				resumeSessionId: "x'; rm -rf /\x1b",
				randomId: RANDOM_ID,
			}),
		).toBe(
			"'claude' '--dangerously-skip-permissions' '--resume' 'x'\\''; rm -rf /'",
		);
	});
});

describe("validateAgentResumeSelection", () => {
	it("accepts an omitted resume", () => {
		expect(() =>
			validateAgentResumeSelection(argvConfig, undefined),
		).not.toThrow();
	});

	it("accepts a session id when the config has resume args", () => {
		expect(() =>
			validateAgentResumeSelection(argvConfig, "abc-123"),
		).not.toThrow();
	});

	it("rejects resuming a config without resume args", () => {
		const config = { ...argvConfig, resumeArgs: [] };
		try {
			validateAgentResumeSelection(config, "abc-123");
			throw new Error("Expected validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).code).toBe("BAD_REQUEST");
			expect((error as Error).message).toBe(
				"Claude does not support resuming a session by id. Omit resumeSessionId to start a new session.",
			);
		}
	});

	it("rejects a session id that sanitizes to empty", () => {
		try {
			validateAgentResumeSelection(argvConfig, "\x1b\x07");
			throw new Error("Expected validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).code).toBe("BAD_REQUEST");
			expect((error as Error).message).toBe(
				"Invalid resume session id for Claude.",
			);
		}
	});
});

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../../../drizzle");

function createTestDb(): HostDb {
	const sqlite = new Database(":memory:");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	// SAFETY: Tests use Bun's SQLite driver, whose run result differs nominally from HostDb; router operations used here are otherwise identical.
	return db as unknown as HostDb;
}

const CLAUDE_CONFIG_ID = "00000000-0000-0000-0000-00000000000a";
const OPENCODE_CONFIG_ID = "00000000-0000-0000-0000-00000000000b";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CHECKED_AT = "2026-08-14T12:00:00.000Z";
const NOW = Date.parse(CHECKED_AT);

async function issueLease(
	db: HostDb,
	input: { agent: string } & AgentLaunchSelection,
	snapshot: AgentCapabilitySnapshot,
	now = NOW,
): Promise<ValidatedCapabilityLease> {
	const lease = await validateAgentLaunchSelection(
		db,
		input,
		mockRefresh(snapshot),
		{ now },
	);
	if (!lease) throw new Error("Expected a validated capability lease");
	return lease;
}

function fallbackSnapshot(
	config: { id: string; presetId: string },
	overrides: Partial<AgentCapabilitySnapshot> = {},
): AgentCapabilitySnapshot {
	return {
		agentId: config.id,
		presetId: config.presetId,
		status: "ready",
		installed: true,
		auth: "authenticated",
		version: "1.0.0",
		modelSource: "fallback",
		models: [],
		message: null,
		checkedAt: CHECKED_AT,
		inventoryCheckedAt: CHECKED_AT,
		...overrides,
	};
}

function runtimeSnapshot(
	config: { id: string; presetId: string },
	models: AgentCapabilitySnapshot["models"],
	overrides: Partial<AgentCapabilitySnapshot> = {},
): AgentCapabilitySnapshot {
	return {
		agentId: config.id,
		presetId: config.presetId,
		status: "ready",
		installed: true,
		auth: "authenticated",
		version: "1.0.0",
		modelSource: "runtime",
		models,
		message: null,
		checkedAt: CHECKED_AT,
		inventoryCheckedAt: CHECKED_AT,
		...overrides,
	};
}

function mockRefresh(snapshot: AgentCapabilitySnapshot): CapabilityRefresher {
	return {
		ensureFreshCapability: async () => snapshot,
	};
}

describe("buildTerminalAgentLaunch", () => {
	function seedConfig(db: ReturnType<typeof createTestDb>) {
		db.insert(schema.hostAgentConfigs)
			.values({
				id: CLAUDE_CONFIG_ID,
				presetId: "claude",
				label: "Claude",
				command: "claude",
				argsJson: JSON.stringify(["--dangerously-skip-permissions"]),
				promptTransport: "argv",
				promptArgsJson: "[]",
				resumeArgsJson: JSON.stringify(["--resume"]),
				envJson: JSON.stringify({ FOO: "bar" }),
				displayOrder: 0,
			})
			.run();
		return {
			id: CLAUDE_CONFIG_ID,
			presetId: "claude",
			label: "Claude",
			capabilityRevision: 1,
		};
	}

	it("resolves the agent config to a runnable command without a terminal", async () => {
		const db = createTestDb();
		const config = seedConfig(db);
		const lease = await issueLease(
			db,
			{ agent: "claude" },
			fallbackSnapshot(config),
		);
		const launch = buildTerminalAgentLaunch(
			db,
			{
				workspaceId: WORKSPACE_ID,
				agent: "claude",
				prompt: "do the thing",
			},
			lease,
			{ now: NOW },
		);
		expect(launch.label).toBe("Claude");
		expect(launch.fullCommand).toBe(
			"FOO='bar' 'claude' '--dangerously-skip-permissions' 'do the thing'",
		);
	});

	it("forwards Claude Code fast mode as an escaped settings override", async () => {
		const db = createTestDb();
		const config = seedConfig(db);
		const selection = { model: "claude-opus-5", speed: "fast" };
		const lease = await issueLease(
			db,
			{ agent: "claude", ...selection },
			fallbackSnapshot(config),
		);
		const launch = buildTerminalAgentLaunch(
			db,
			{
				workspaceId: WORKSPACE_ID,
				agent: "claude",
				prompt: "do the thing",
				...selection,
			},
			lease,
			{ now: NOW },
		);
		expect(launch.fullCommand).toBe(
			"FOO='bar' 'claude' '--dangerously-skip-permissions' '--model' 'claude-opus-5' '--settings' '{\"fastMode\":true}' 'do the thing'",
		);
	});

	it("keeps OpenCode reasoning variants independent from agent modes", async () => {
		const db = createTestDb();
		const config = {
			id: OPENCODE_CONFIG_ID,
			presetId: "opencode",
			label: "OpenCode",
			capabilityRevision: 1,
		};
		db.insert(schema.hostAgentConfigs)
			.values({
				id: config.id,
				presetId: config.presetId,
				label: config.label,
				command: "opencode",
				argsJson: "[]",
				promptTransport: "argv",
				promptArgsJson: "[]",
				resumeArgsJson: "[]",
				envJson: "{}",
				displayOrder: 0,
			})
			.run();
		const selection = {
			model: "openai/gpt-5.6-sol",
			effort: "high",
			mode: "plan",
		};
		const lease = await issueLease(
			db,
			{ agent: "opencode", ...selection },
			fallbackSnapshot(config),
		);
		const launch = buildTerminalAgentLaunch(
			db,
			{
				workspaceId: WORKSPACE_ID,
				agent: "opencode",
				prompt: "do the thing",
				...selection,
			},
			lease,
			{ now: NOW },
		);
		expect(launch.fullCommand).toBe(
			"'opencode' '--model' 'openai/gpt-5.6-sol' '--variant' 'high' '--agent' 'plan' 'do the thing'",
		);
	});

	it("combines Claude Code Fast Mode and Ultracode settings", async () => {
		const db = createTestDb();
		const config = seedConfig(db);
		const selection = {
			model: "claude-opus-5",
			effort: "ultracode",
			speed: "fast",
		};
		const lease = await issueLease(
			db,
			{ agent: "claude", ...selection },
			fallbackSnapshot(config),
		);
		const launch = buildTerminalAgentLaunch(
			db,
			{
				workspaceId: WORKSPACE_ID,
				agent: "claude",
				prompt: "do the thing",
				...selection,
			},
			lease,
			{ now: NOW },
		);
		expect(launch.fullCommand).toBe(
			"FOO='bar' 'claude' '--dangerously-skip-permissions' '--model' 'claude-opus-5' '--effort' 'xhigh' '--settings' '{\"fastMode\":true,\"ultracode\":true}' 'do the thing'",
		);
	});

	it("leaves Claude Code's one-turn ultrathink keyword in the user's prompt", async () => {
		const db = createTestDb();
		const config = seedConfig(db);
		const selection = { model: "claude-opus-5" };
		const lease = await issueLease(
			db,
			{ agent: "claude", ...selection },
			fallbackSnapshot(config),
		);
		const launch = buildTerminalAgentLaunch(
			db,
			{
				workspaceId: WORKSPACE_ID,
				agent: "claude",
				prompt: "ultrathink about this change",
				...selection,
			},
			lease,
			{ now: NOW },
		);
		expect(launch.fullCommand).toBe(
			"FOO='bar' 'claude' '--dangerously-skip-permissions' '--model' 'claude-opus-5' 'ultrathink about this change'",
		);
	});

	it("forwards Claude Haiku Thinking as a settings override", async () => {
		const db = createTestDb();
		const config = seedConfig(db);
		const selection = { model: "claude-haiku-4-5", effort: "on" };
		const lease = await issueLease(
			db,
			{ agent: "claude", ...selection },
			fallbackSnapshot(config),
		);
		const launch = buildTerminalAgentLaunch(
			db,
			{
				workspaceId: WORKSPACE_ID,
				agent: "claude",
				prompt: "do the thing",
				...selection,
			},
			lease,
			{ now: NOW },
		);
		expect(launch.fullCommand).toBe(
			"FOO='bar' 'claude' '--dangerously-skip-permissions' '--model' 'claude-haiku-4-5' '--settings' '{\"alwaysThinkingEnabled\":true}' 'do the thing'",
		);
	});

	it("forwards a supported Claude Code context window in the model id", async () => {
		const db = createTestDb();
		const config = seedConfig(db);
		const selection = { model: "claude-opus-5", contextWindow: "1m" };
		const lease = await issueLease(
			db,
			{ agent: "claude", ...selection },
			fallbackSnapshot(config),
		);
		const launch = buildTerminalAgentLaunch(
			db,
			{
				workspaceId: WORKSPACE_ID,
				agent: "claude",
				prompt: "do the thing",
				...selection,
			},
			lease,
			{ now: NOW },
		);
		expect(launch.fullCommand).toBe(
			"FOO='bar' 'claude' '--dangerously-skip-permissions' '--model' 'claude-opus-5[1m]' 'do the thing'",
		);
	});

	it("resumes a previous session with an empty prompt", async () => {
		const db = createTestDb();
		const config = seedConfig(db);
		const lease = await issueLease(
			db,
			{ agent: "claude" },
			fallbackSnapshot(config),
		);
		const launch = buildTerminalAgentLaunch(
			db,
			{
				workspaceId: WORKSPACE_ID,
				agent: "claude",
				prompt: "",
				resumeSessionId: "abc-123",
			},
			lease,
			{ now: NOW },
		);
		expect(launch.fullCommand).toBe(
			"FOO='bar' 'claude' '--dangerously-skip-permissions' '--resume' 'abc-123'",
		);
	});

	it("rejects a resume when the agent config has no resume args", async () => {
		const db = createTestDb();
		const config = {
			id: OPENCODE_CONFIG_ID,
			presetId: "custom",
			label: "My Agent",
			capabilityRevision: 1,
		};
		db.insert(schema.hostAgentConfigs)
			.values({
				id: config.id,
				presetId: config.presetId,
				label: config.label,
				command: "my-agent",
				argsJson: "[]",
				promptTransport: "argv",
				promptArgsJson: "[]",
				envJson: "{}",
				displayOrder: 1,
			})
			.run();
		const lease = await issueLease(
			db,
			{ agent: "custom" },
			fallbackSnapshot(config),
		);
		expect(() =>
			buildTerminalAgentLaunch(
				db,
				{
					workspaceId: WORKSPACE_ID,
					agent: "custom",
					prompt: "",
					resumeSessionId: "abc-123",
				},
				lease,
				{ now: NOW },
			),
		).toThrow(/does not support resuming a session by id/);
	});

	it("throws NOT_FOUND for an unknown agent", async () => {
		const db = createTestDb();
		const config = seedConfig(db);
		const lease = await issueLease(
			db,
			{ agent: "claude" },
			fallbackSnapshot(config),
		);
		expect(() =>
			buildTerminalAgentLaunch(
				db,
				{
					workspaceId: WORKSPACE_ID,
					agent: "nope",
					prompt: "p",
				},
				lease,
				{ now: NOW },
			),
		).toThrow(/No host agent config matching 'nope'/);
	});

	it("rejects a model-A lease used to build model B", async () => {
		const db = createTestDb();
		const config = seedConfig(db);
		const lease = await issueLease(
			db,
			{ agent: "claude", model: "claude-fable-5" },
			fallbackSnapshot(config),
		);
		try {
			buildTerminalAgentLaunch(
				db,
				{
					workspaceId: WORKSPACE_ID,
					agent: "claude",
					prompt: "do the thing",
					model: "claude-opus-5",
				},
				lease,
				{ now: NOW },
			);
			throw new Error("Expected launch to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).code).toBe("BAD_REQUEST");
			expect((error as TRPCError).cause).toMatchObject({
				kind: "selection_mismatch",
			});
		}
	});

	it("rejects a lease after the agent config revision changes", async () => {
		const db = createTestDb();
		const config = seedConfig(db);
		const lease = await issueLease(
			db,
			{ agent: "claude", model: "claude-opus-5" },
			fallbackSnapshot(config),
		);
		db.update(schema.hostAgentConfigs)
			.set({ capabilityRevision: 2 })
			.where(eq(schema.hostAgentConfigs.id, config.id))
			.run();
		try {
			buildTerminalAgentLaunch(
				db,
				{
					workspaceId: WORKSPACE_ID,
					agent: "claude",
					prompt: "do the thing",
					model: "claude-opus-5",
				},
				lease,
				{ now: NOW },
			);
			throw new Error("Expected launch to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).code).toBe("PRECONDITION_FAILED");
			expect((error as TRPCError).cause).toMatchObject({
				kind: "config_changed",
			});
		}
	});

	it("rejects an expired lease", async () => {
		const db = createTestDb();
		const config = seedConfig(db);
		const lease = await issueLease(
			db,
			{ agent: "claude", model: "claude-opus-5" },
			fallbackSnapshot(config),
		);
		try {
			buildTerminalAgentLaunch(
				db,
				{
					workspaceId: WORKSPACE_ID,
					agent: "claude",
					prompt: "do the thing",
					model: "claude-opus-5",
				},
				lease,
				{ now: lease.expiresAt },
			);
			throw new Error("Expected launch to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).code).toBe("PRECONDITION_FAILED");
			expect((error as TRPCError).cause).toMatchObject({
				kind: "expired_lease",
			});
		}
	});

	it("launches a runtime Pi max effort advertised by the live inventory", async () => {
		const db = createTestDb();
		const config = {
			id: "00000000-0000-0000-0000-00000000000c",
			presetId: "pi",
			label: "Pi",
			capabilityRevision: 1,
		};
		db.insert(schema.hostAgentConfigs)
			.values({
				id: config.id,
				presetId: config.presetId,
				label: config.label,
				command: "pi",
				argsJson: "[]",
				promptTransport: "argv",
				promptArgsJson: "[]",
				resumeArgsJson: "[]",
				envJson: "{}",
				displayOrder: 0,
			})
			.run();
		const selection = { model: "provider/model", effort: "max" };
		const lease = await issueLease(
			db,
			{ agent: "pi", ...selection },
			runtimeSnapshot(config, [
				{
					id: "provider/model",
					label: "Provider Model",
					reasoning: {
						state: "supported",
						defaultId: "max",
						options: [{ id: "max", label: "Max" }],
					},
				},
			]),
		);
		const launch = buildTerminalAgentLaunch(
			db,
			{
				workspaceId: WORKSPACE_ID,
				agent: "pi",
				prompt: "do the thing",
				...selection,
			},
			lease,
			{ now: NOW },
		);
		expect(launch.fullCommand).toBe(
			"'pi' '--model' 'provider/model' '--thinking' 'max' 'do the thing'",
		);
	});

	it("launches a newly advertised runtime Codex model", async () => {
		const db = createTestDb();
		const config = {
			id: "00000000-0000-0000-0000-00000000000d",
			presetId: "codex",
			label: "Codex",
			capabilityRevision: 1,
		};
		db.insert(schema.hostAgentConfigs)
			.values({
				id: config.id,
				presetId: config.presetId,
				label: config.label,
				command: "codex",
				argsJson: "[]",
				promptTransport: "argv",
				promptArgsJson: "[]",
				resumeArgsJson: "[]",
				envJson: "{}",
				displayOrder: 0,
			})
			.run();
		const selection = { model: "gpt-6-codex" };
		const lease = await issueLease(
			db,
			{ agent: "codex", ...selection },
			runtimeSnapshot(config, [
				{
					id: "gpt-6-codex",
					label: "GPT-6 Codex",
					reasoning: { state: "unknown" },
				},
			]),
		);
		const launch = buildTerminalAgentLaunch(
			db,
			{
				workspaceId: WORKSPACE_ID,
				agent: "codex",
				prompt: "do the thing",
				...selection,
			},
			lease,
			{ now: NOW },
		);
		expect(launch.fullCommand).toBe(
			"'codex' '--model' 'gpt-6-codex' 'do the thing'",
		);
	});

	it("does not silently omit a retired runtime model and launch the CLI default", async () => {
		const db = createTestDb();
		const config = seedConfig(db);
		await expect(
			issueLease(
				db,
				{ agent: "claude", model: "retired-model" },
				runtimeSnapshot(config, [
					{
						id: "claude-opus-5",
						label: "Opus 5",
						reasoning: { state: "unknown" },
					},
				]),
			),
		).rejects.toThrow(/Model "retired-model" is not available/);
		expect(
			getAgentModelSupport("claude")?.models.some(
				(model) => model.id === "retired-model",
			),
		).toBe(false);
	});

	it("honors a Vibe runtime inventory instead of the static catalog", async () => {
		const db = createTestDb();
		const config = {
			id: "00000000-0000-0000-0000-00000000000e",
			presetId: "vibe",
			label: "Vibe",
			capabilityRevision: 1,
		};
		db.insert(schema.hostAgentConfigs)
			.values({
				id: config.id,
				presetId: config.presetId,
				label: config.label,
				command: "vibe",
				argsJson: "[]",
				promptTransport: "argv",
				promptArgsJson: "[]",
				resumeArgsJson: "[]",
				envJson: "{}",
				displayOrder: 0,
			})
			.run();
		const selection = { model: "vibe-runtime-model" };
		const snapshot = runtimeSnapshot(config, [
			{
				id: "vibe-runtime-model",
				label: "Vibe Runtime",
				reasoning: { state: "unsupported" },
			},
		]);
		const lease = await issueLease(
			db,
			{ agent: "vibe", ...selection },
			snapshot,
		);
		const launch = buildTerminalAgentLaunch(
			db,
			{
				workspaceId: WORKSPACE_ID,
				agent: "vibe",
				prompt: "do the thing",
				...selection,
			},
			lease,
			{ now: NOW },
		);
		expect(launch.fullCommand).toBe(
			"VIBE_ACTIVE_MODEL='vibe-runtime-model' 'vibe' 'do the thing'",
		);
		await expect(
			issueLease(db, { agent: "vibe", model: "mistral-medium-3.5" }, snapshot),
		).rejects.toThrow(/Model "mistral-medium-3.5" is not available/);
	});
});

describe("validateAgentEffortSelection", () => {
	it("leaves the effort unset so the agent can use its own default", () => {
		expect(() =>
			validateAgentEffortSelection("codex", "Codex", undefined),
		).not.toThrow();
	});

	it("accepts a supported effort for the selected agent", () => {
		expect(() =>
			validateAgentEffortSelection("codex", "Codex", "xhigh", "gpt-5.6-sol"),
		).not.toThrow();
	});

	it("accepts a runtime effort outside the curated catalog", () => {
		expect(() =>
			validateAgentEffortSelection("pi", "Pi", "max", "provider/model", {
				state: "supported",
				options: [{ id: "max", label: "Max" }],
			}),
		).not.toThrow();
	});

	it("rejects a curated effort when runtime reports unsupported", () => {
		expect(() =>
			validateAgentEffortSelection("codex", "Codex", "high", "gpt-5.6-sol", {
				state: "unsupported",
			}),
		).toThrow(TRPCError);
	});

	it("rejects an invalid effort with the supported values", () => {
		try {
			validateAgentEffortSelection("codex", "Codex", "extreme", "gpt-5.6-sol");
			throw new Error("Expected validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).code).toBe("BAD_REQUEST");
			expect((error as TRPCError).cause).toMatchObject({
				kind: "unsupported_trait",
			});
			expect((error as TRPCError).cause).toBeInstanceOf(
				AgentLaunchCapabilityError,
			);
			expect((error as Error).message).toBe(
				'Unsupported reasoning effort "extreme" for Codex. Choose one of: low, medium, high, xhigh, max, ultra.',
			);
		}
	});

	it("rejects overrides for agents without effort support", () => {
		try {
			validateAgentEffortSelection("superset", "Superset", "high");
			throw new Error("Expected validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).code).toBe("BAD_REQUEST");
			expect((error as Error).message).toBe(
				"Superset does not support a reasoning effort override. Omit effort to use the agent default.",
			);
		}
	});
});

describe("validateAgentModeSelection", () => {
	it("rejects an unknown OpenCode mode", () => {
		try {
			validateAgentModeSelection("opencode", "OpenCode", "review");
			throw new Error("Expected validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).cause).toMatchObject({
				kind: "unsupported_trait",
			});
			expect((error as Error).message).toContain(
				'Unsupported mode "review" for OpenCode',
			);
		}
	});
});

describe("validateAgentSpeedSelection", () => {
	it("rejects Fast Mode on a Claude model that does not support it", () => {
		try {
			validateAgentSpeedSelection("claude", "Claude", "fast", "claude-fable-5");
			throw new Error("Expected validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).cause).toMatchObject({
				kind: "unsupported_trait",
			});
		}
	});
});

describe("validateAgentContextWindowSelection", () => {
	it("rejects a context window the selected model does not advertise", () => {
		try {
			validateAgentContextWindowSelection(
				"claude",
				"Claude",
				"1m",
				"claude-opus-4-8",
			);
			throw new Error("Expected validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).cause).toMatchObject({
				kind: "unsupported_trait",
			});
		}
	});
});

describe("validateAgentLaunchSelection", () => {
	function seedClaude(db: HostDb) {
		const config = {
			id: CLAUDE_CONFIG_ID,
			presetId: "claude",
			label: "Claude",
			capabilityRevision: 1,
		};
		db.insert(schema.hostAgentConfigs)
			.values({
				id: config.id,
				presetId: config.presetId,
				label: config.label,
				command: "claude",
				argsJson: "[]",
				promptTransport: "argv",
				promptArgsJson: "[]",
				resumeArgsJson: "[]",
				envJson: "{}",
				capabilityRevision: config.capabilityRevision,
				displayOrder: 0,
			})
			.run();
		return config;
	}

	it("issues a selection-bound lease after a live ready check", async () => {
		const db = createTestDb();
		const config = seedClaude(db);
		const lease = await validateAgentLaunchSelection(
			db,
			{ agent: "claude", model: "claude-opus-5", speed: "fast" },
			mockRefresh(
				runtimeSnapshot(config, [
					{
						id: "claude-opus-5",
						label: "Opus 5",
						reasoning: { state: "unknown" },
					},
				]),
			),
			{ now: NOW },
		);
		expect(lease).toMatchObject({
			agentId: config.id,
			presetId: "claude",
			configRevision: 1,
			inventoryCheckedAt: CHECKED_AT,
			selection: { model: "claude-opus-5", speed: "fast" },
			allowedModelIds: ["claude-opus-5"],
		});
		expect(lease?.expiresAt).toBe(NOW + CAPABILITY_LAUNCH_FRESHNESS_MS);
	});

	it("binds expiry to the live inventory timestamp instead of resetting the window", async () => {
		const db = createTestDb();
		const config = seedClaude(db);
		const staleCheckedAt = new Date(NOW - 20_000).toISOString();
		const snapshot = runtimeSnapshot(
			config,
			[
				{
					id: "claude-opus-5",
					label: "Opus 5",
					reasoning: { state: "unknown" },
				},
			],
			{ checkedAt: staleCheckedAt, inventoryCheckedAt: staleCheckedAt },
		);
		const first = await validateAgentLaunchSelection(
			db,
			{ agent: "claude", model: "claude-opus-5" },
			mockRefresh(snapshot),
			{ now: NOW },
		);
		const later = await validateAgentLaunchSelection(
			db,
			{ agent: "claude", model: "claude-opus-5" },
			mockRefresh(snapshot),
			{ now: NOW + 5_000 },
		);
		expect(first?.expiresAt).toBe(
			NOW - 20_000 + CAPABILITY_LAUNCH_FRESHNESS_MS,
		);
		expect(later?.expiresAt).toBe(first?.expiresAt);
	});

	it("rejects a snapshot bound to a different agent identity", async () => {
		const db = createTestDb();
		const config = seedClaude(db);
		try {
			await validateAgentLaunchSelection(
				db,
				{ agent: "claude", model: "claude-opus-5" },
				mockRefresh(
					runtimeSnapshot(
						config,
						[
							{
								id: "claude-opus-5",
								label: "Opus 5",
								reasoning: { state: "unknown" },
							},
						],
						{
							agentId: "00000000-0000-0000-0000-000000000099",
						},
					),
				),
				{ now: NOW },
			);
			throw new Error("Expected validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).cause).toMatchObject({
				kind: "config_changed",
			});
		}
	});

	it("rejects an explicit runtime model when the preset has no trusted transport", async () => {
		const db = createTestDb();
		const config = {
			id: "00000000-0000-0000-0000-0000000000ff",
			presetId: "custom",
			label: "My Agent",
			capabilityRevision: 1,
		};
		db.insert(schema.hostAgentConfigs)
			.values({
				id: config.id,
				presetId: config.presetId,
				label: config.label,
				command: "my-agent",
				argsJson: "[]",
				promptTransport: "argv",
				promptArgsJson: "[]",
				resumeArgsJson: "[]",
				envJson: "{}",
				capabilityRevision: 1,
				displayOrder: 0,
			})
			.run();
		try {
			await validateAgentLaunchSelection(
				db,
				{ agent: "custom", model: "runtime-only-model" },
				mockRefresh(
					runtimeSnapshot(config, [
						{
							id: "runtime-only-model",
							label: "Runtime Only",
							reasoning: { state: "unknown" },
						},
					]),
				),
				{ now: NOW },
			);
			throw new Error("Expected validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).cause).toMatchObject({
				kind: "unsupported_trait",
			});
		}
	});

	it("rejects a missing live capability timestamp", async () => {
		const db = createTestDb();
		const config = seedClaude(db);
		try {
			await validateAgentLaunchSelection(
				db,
				{ agent: "claude", model: "claude-opus-5" },
				mockRefresh(
					runtimeSnapshot(
						config,
						[
							{
								id: "claude-opus-5",
								label: "Opus 5",
								reasoning: { state: "unknown" },
							},
						],
						{ checkedAt: "", inventoryCheckedAt: null },
					),
				),
				{ now: NOW },
			);
			throw new Error("Expected validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).cause).toMatchObject({
				kind: "unavailable",
			});
		}
	});

	it("rejects a retired runtime model before construction", async () => {
		const db = createTestDb();
		const config = seedClaude(db);
		try {
			await validateAgentLaunchSelection(
				db,
				{ agent: "claude", model: "retired-model" },
				mockRefresh(
					runtimeSnapshot(config, [
						{
							id: "claude-opus-5",
							label: "Opus 5",
							reasoning: { state: "unknown" },
						},
					]),
				),
				{ now: NOW },
			);
			throw new Error("Expected validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).cause).toMatchObject({
				kind: "retired_model",
			});
		}
	});

	it("does not revive a static effort when runtime reports unsupported", async () => {
		const db = createTestDb();
		const config = {
			id: "00000000-0000-0000-0000-00000000000d",
			presetId: "codex",
			label: "Codex",
			capabilityRevision: 1,
		};
		db.insert(schema.hostAgentConfigs)
			.values({
				id: config.id,
				presetId: config.presetId,
				label: config.label,
				command: "codex",
				argsJson: "[]",
				promptTransport: "argv",
				promptArgsJson: "[]",
				resumeArgsJson: "[]",
				envJson: "{}",
				capabilityRevision: 1,
				displayOrder: 0,
			})
			.run();
		try {
			await validateAgentLaunchSelection(
				db,
				{ agent: "codex", model: "gpt-5.6-sol", effort: "high" },
				mockRefresh(
					runtimeSnapshot(config, [
						{
							id: "gpt-5.6-sol",
							label: "GPT-5.6 Sol",
							reasoning: { state: "unsupported" },
						},
					]),
				),
				{ now: NOW },
			);
			throw new Error("Expected validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).cause).toMatchObject({
				kind: "unsupported_trait",
			});
		}
	});
});

describe("agents.run launch contract", () => {
	function seedWorkspace(db: HostDb) {
		db.insert(schema.workspaces)
			.values({
				id: WORKSPACE_ID,
				worktreePath: "/tmp/launch-contract-ws",
				branch: "main",
			})
			.run();
	}

	function createRunCaller(db: HostDb, snapshot: AgentCapabilitySnapshot) {
		const context = {
			db,
			isAuthenticated: true,
			capabilityRefresh: mockRefresh({
				...snapshot,
				checkedAt: new Date().toISOString(),
				inventoryCheckedAt: new Date().toISOString(),
			}),
		};
		// SAFETY: This router test exercises only the three context services supplied above.
		return agentsRouter.createCaller(context as HostServiceContext);
	}

	it("preflights a retired model on agents.run before creating a terminal", async () => {
		const db = createTestDb();
		db.insert(schema.hostAgentConfigs)
			.values({
				id: CLAUDE_CONFIG_ID,
				presetId: "claude",
				label: "Claude",
				command: "claude",
				argsJson: "[]",
				promptTransport: "argv",
				promptArgsJson: "[]",
				resumeArgsJson: JSON.stringify(["--resume"]),
				envJson: "{}",
				capabilityRevision: 1,
				displayOrder: 0,
			})
			.run();
		seedWorkspace(db);
		const caller = createRunCaller(
			db,
			runtimeSnapshot({ id: CLAUDE_CONFIG_ID, presetId: "claude" }, [
				{
					id: "claude-opus-5",
					label: "Opus 5",
					reasoning: { state: "unknown" },
				},
			]),
		);
		try {
			await caller.run({
				workspaceId: WORKSPACE_ID,
				agent: "claude",
				prompt: "do the thing",
				model: "retired-model",
			});
			throw new Error("Expected agents.run to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).cause).toMatchObject({
				kind: "retired_model",
			});
		}
	});

	it("returns a trusted command from resolveLaunchCommand without creating a terminal", async () => {
		const db = createTestDb();
		db.insert(schema.hostAgentConfigs)
			.values({
				id: CLAUDE_CONFIG_ID,
				presetId: "claude",
				label: "Claude",
				command: "claude",
				argsJson: JSON.stringify(["--dangerously-skip-permissions"]),
				promptTransport: "argv",
				promptArgsJson: "[]",
				resumeArgsJson: JSON.stringify(["--resume"]),
				envJson: "{}",
				capabilityRevision: 1,
				displayOrder: 0,
			})
			.run();
		const caller = createRunCaller(
			db,
			runtimeSnapshot({ id: CLAUDE_CONFIG_ID, presetId: "claude" }, [
				{
					id: "claude-opus-5",
					label: "Opus 5",
					reasoning: { state: "unknown" },
				},
			]),
		);
		const result = await caller.resolveLaunchCommand({
			agent: "claude",
			model: "claude-opus-5",
		});
		expect(result.label).toBe("Claude");
		expect(result.command).toContain("'claude'");
		expect(result.command).toContain("'--model' 'claude-opus-5'");
		expect(db.select().from(schema.terminalSessions).all()).toEqual([]);
		expect(db.select().from(schema.workspaces).all()).toEqual([]);
	});

	it("rejects resolveLaunchCommand for a retired model before any terminal exists", async () => {
		const db = createTestDb();
		db.insert(schema.hostAgentConfigs)
			.values({
				id: CLAUDE_CONFIG_ID,
				presetId: "claude",
				label: "Claude",
				command: "claude",
				argsJson: "[]",
				promptTransport: "argv",
				promptArgsJson: "[]",
				resumeArgsJson: JSON.stringify(["--resume"]),
				envJson: "{}",
				capabilityRevision: 1,
				displayOrder: 0,
			})
			.run();
		const caller = createRunCaller(
			db,
			runtimeSnapshot({ id: CLAUDE_CONFIG_ID, presetId: "claude" }, [
				{
					id: "claude-opus-5",
					label: "Opus 5",
					reasoning: { state: "unknown" },
				},
			]),
		);
		try {
			await caller.resolveLaunchCommand({
				agent: "claude",
				model: "retired-model",
			});
			throw new Error("Expected resolveLaunchCommand to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).cause).toMatchObject({
				kind: "retired_model",
			});
		}
		expect(db.select().from(schema.terminalSessions).all()).toEqual([]);
	});

	it("preflights resume through the same launch validator", async () => {
		const db = createTestDb();
		db.insert(schema.hostAgentConfigs)
			.values({
				id: CLAUDE_CONFIG_ID,
				presetId: "claude",
				label: "Claude",
				command: "claude",
				argsJson: "[]",
				promptTransport: "argv",
				promptArgsJson: "[]",
				resumeArgsJson: JSON.stringify(["--resume"]),
				envJson: "{}",
				capabilityRevision: 1,
				displayOrder: 0,
			})
			.run();
		seedWorkspace(db);
		const caller = createRunCaller(
			db,
			runtimeSnapshot({ id: CLAUDE_CONFIG_ID, presetId: "claude" }, [
				{
					id: "claude-opus-5",
					label: "Opus 5",
					reasoning: { state: "unknown" },
				},
			]),
		);
		try {
			await caller.run({
				workspaceId: WORKSPACE_ID,
				agent: "claude",
				prompt: "",
				model: "retired-model",
				resumeSessionId: "abc-123",
			});
			throw new Error("Expected resume preflight to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).cause).toMatchObject({
				kind: "retired_model",
			});
		}
	});
});
