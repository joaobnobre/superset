import { describe, expect, it } from "bun:test";
import {
	AGENT_EFFORT_SUPPORT,
	AGENT_MODEL_SUPPORT,
	buildAgentEffortArgs,
	buildAgentModeArgs,
	buildAgentModelArgs,
	buildAgentModelEnv,
	buildAgentRuntimeTraitArgs,
	buildAgentSpeedArgs,
	getAgentContextWindowSupport,
	getAgentEffortSupport,
	getAgentModelSupport,
	getAgentModeSupport,
	getAgentSpeedSupport,
	SUPERSET_CHAT_MODELS,
} from "./agent-models";
import { BUILTIN_TERMINAL_AGENT_TYPES } from "./builtin-terminal-agents";

describe("AGENT_MODEL_SUPPORT", () => {
	it("lists explicit Claude Code model versions", () => {
		expect(getAgentModelSupport("claude")?.defaultModelId).toBe(
			"claude-fable-5",
		);
		expect(getAgentModelSupport("claude")?.models).toEqual([
			{ id: "claude-fable-5", label: "Fable 5" },
			{ id: "claude-opus-5", label: "Opus 5" },
			{ id: "claude-sonnet-5", label: "Sonnet 5" },
			{ id: "claude-opus-4-8", label: "Opus 4.8" },
			{ id: "claude-opus-4-7", label: "Opus 4.7" },
			{ id: "claude-opus-4-6", label: "Opus 4.6" },
			{ id: "claude-opus-4-5", label: "Opus 4.5" },
			{ id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
			{ id: "claude-haiku-4-5", label: "Haiku 4.5" },
		]);
	});

	it("uses the first current Codex model instead of a synthetic default", () => {
		expect(getAgentModelSupport("codex")?.defaultModelId).toBe("gpt-5.6-sol");
	});

	it("only references builtin presets (or the superset chat agent)", () => {
		const validIds = new Set<string>([
			...BUILTIN_TERMINAL_AGENT_TYPES,
			"superset",
		]);
		for (const entry of AGENT_MODEL_SUPPORT) {
			expect(validIds.has(entry.presetId)).toBe(true);
		}
	});

	it("has a model flag, a model env, or (superset) neither", () => {
		for (const entry of AGENT_MODEL_SUPPORT) {
			if (entry.presetId === "superset") {
				expect(entry.modelFlag).toBeNull();
			} else if (entry.modelEnv) {
				// env-based presets (Vibe) carry the model via an env var, no flag
				expect(entry.modelFlag).toBeNull();
			} else if (entry.presetId === "polygraph") {
				// polygraph's dropdown picks the harness it launches, not a model
				expect(entry.modelFlag).toBe("--agent");
			} else {
				expect(entry.modelFlag).toBe("--model");
			}
		}
	});

	it("lists at least one model per entry", () => {
		for (const entry of AGENT_MODEL_SUPPORT) {
			if (["antigravity", "grok", "kimi", "pi"].includes(entry.presetId)) {
				expect(entry.models).toEqual([]);
			} else {
				expect(entry.models.length).toBeGreaterThan(0);
			}
		}
	});
});

describe("buildAgentSpeedArgs", () => {
	it("uses provider-specific performance labels", () => {
		expect(getAgentSpeedSupport("claude", "claude-opus-5")).toMatchObject({
			label: "Fast Mode",
			speeds: [
				{ id: "standard", label: "Off" },
				{ id: "fast", label: "On" },
			],
		});
		expect(getAgentSpeedSupport("codex", "gpt-5.6-sol")).toMatchObject({
			label: "Service Tier",
			speeds: [
				{ id: "standard", label: "Standard" },
				{ id: "fast", label: "Fast" },
			],
		});
	});

	it("maps Codex speed choices to its stable feature flag", () => {
		expect(buildAgentSpeedArgs("codex", "standard", "gpt-5.6-sol")).toEqual([
			"--disable",
			"fast_mode",
		]);
		expect(buildAgentSpeedArgs("codex", "fast", "gpt-5.6-sol")).toEqual([
			"--enable",
			"fast_mode",
		]);
	});

	it("maps Claude Code speed choices to its fastMode setting", () => {
		expect(buildAgentSpeedArgs("claude", "standard", "claude-opus-5")).toEqual([
			"--settings",
			'{"fastMode":false}',
		]);
		expect(buildAgentSpeedArgs("claude", "fast", "claude-opus-5")).toEqual([
			"--settings",
			'{"fastMode":true}',
		]);
	});

	it("ignores unsupported speed choices", () => {
		expect(buildAgentSpeedArgs("amp", "fast", "model")).toEqual([]);
		expect(buildAgentSpeedArgs("codex", "turbo", "gpt-5.6-sol")).toEqual([]);
		expect(buildAgentSpeedArgs("codex", undefined)).toEqual([]);
		expect(buildAgentSpeedArgs("claude", "fast", "claude-fable-5")).toEqual([]);
	});
});

describe("buildAgentRuntimeTraitArgs", () => {
	it("combines Claude Fast Mode and Ultracode into one settings object", () => {
		expect(
			buildAgentRuntimeTraitArgs("claude", {
				model: "claude-opus-5",
				effort: "ultracode",
				speed: "fast",
			}),
		).toEqual(["--settings", '{"fastMode":true,"ultracode":true}']);
	});

	it("maps Haiku Thinking to the Claude setting", () => {
		expect(
			buildAgentRuntimeTraitArgs("claude", {
				model: "claude-haiku-4-5",
				effort: "on",
			}),
		).toEqual(["--settings", '{"alwaysThinkingEnabled":true}']);
	});
});

describe("SUPERSET_CHAT_MODELS", () => {
	it("includes opus 5 and the GPT-5.6 Codex models", () => {
		const ids = SUPERSET_CHAT_MODELS.map((model) => model.id);
		expect(ids).toContain("anthropic/claude-opus-5");
		expect(ids).toContain("openai/gpt-5.6-sol");
		expect(ids).toContain("openai/gpt-5.6-terra");
		expect(ids).toContain("openai/gpt-5.6-luna");
	});
});

describe("getAgentModelSupport", () => {
	it("returns the entry for a supported preset", () => {
		expect(getAgentModelSupport("claude")?.modelFlag).toBe("--model");
	});

	it("returns undefined for presets without model support", () => {
		expect(getAgentModelSupport("amp")).toBeUndefined();
		expect(getAgentModelSupport("nonexistent")).toBeUndefined();
	});
});

describe("buildAgentModelArgs", () => {
	it("accepts a newly discovered model without an app catalog update", () => {
		expect(
			buildAgentModelArgs("codex", "gpt-6-codex", undefined, ["gpt-6-codex"]),
		).toEqual(["--model", "gpt-6-codex"]);
	});

	it("builds flag + value tokens", () => {
		expect(buildAgentModelArgs("claude", "claude-sonnet-4-6")).toEqual([
			"--model",
			"claude-sonnet-4-6",
		]);
	});

	it("keeps OpenCode reasoning variants separate from agent modes", () => {
		expect(getAgentEffortSupport("opencode")?.label).toBe("Reasoning");
		expect(buildAgentEffortArgs("opencode", "high")).toEqual([
			"--variant",
			"high",
		]);
		expect(getAgentModeSupport("opencode")?.label).toBe("Agent");
		expect(buildAgentModeArgs("opencode", "build")).toEqual([
			"--agent",
			"build",
		]);
		expect(buildAgentModeArgs("opencode", "plan")).toEqual(["--agent", "plan"]);
	});

	it("returns [] when no model is set", () => {
		expect(buildAgentModelArgs("claude", undefined)).toEqual([]);
		expect(buildAgentModelArgs("claude", "")).toEqual([]);
	});

	it("returns [] for unsupported presets", () => {
		expect(buildAgentModelArgs("amp", "sonnet")).toEqual([]);
	});

	it("returns [] for model ids outside the preset's curated list", () => {
		expect(buildAgentModelArgs("claude", "bad-model")).toEqual([]);
		expect(buildAgentModelArgs("codex", "sonnet")).toEqual([]);
	});

	it("returns [] for superset (model travels via chat metadata)", () => {
		expect(
			buildAgentModelArgs("superset", "anthropic/claude-opus-4-8"),
		).toEqual([]);
	});

	it("includes fable 5 in claude's curated list", () => {
		expect(buildAgentModelArgs("claude", "claude-fable-5")).toEqual([
			"--model",
			"claude-fable-5",
		]);
	});

	it("includes opus 5 in claude's curated list", () => {
		expect(buildAgentModelArgs("claude", "claude-opus-5")).toEqual([
			"--model",
			"claude-opus-5",
		]);
	});

	it("includes fable for the other CLIs that support it", () => {
		expect(
			buildAgentModelArgs("cursor-agent", "claude-fable-5-thinking-high"),
		).toEqual(["--model", "claude-fable-5-thinking-high"]);
		expect(
			buildAgentModelArgs("cursor-agent", "claude-fable-5-thinking-xhigh"),
		).toEqual(["--model", "claude-fable-5-thinking-xhigh"]);
		expect(buildAgentModelArgs("opencode", "anthropic/claude-fable-5")).toEqual(
			["--model", "anthropic/claude-fable-5"],
		);
	});

	it("uses the current versioned Copilot CLI catalog", () => {
		for (const model of [
			"claude-sonnet-4.6",
			"gpt-5.4",
			"gpt-5.3-codex",
			"gemini-3.1-pro-preview",
		]) {
			expect(buildAgentModelArgs("copilot", model)).toEqual(["--model", model]);
		}
	});

	it("includes every GPT-5.6 Codex model", () => {
		for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
			expect(buildAgentModelArgs("codex", model)).toEqual(["--model", model]);
		}
	});

	it("includes opus 5 and the GPT-5.6 models for the other CLIs", () => {
		for (const model of [
			"claude-opus-5-high",
			"gpt-5.6-terra-medium",
			"gpt-5.6-luna-medium",
		]) {
			expect(buildAgentModelArgs("cursor-agent", model)).toEqual([
				"--model",
				model,
			]);
		}
		for (const model of [
			"anthropic/claude-opus-5",
			"openai/gpt-5.6-sol",
			"openai/gpt-5.6-terra",
			"openai/gpt-5.6-luna",
		]) {
			expect(buildAgentModelArgs("opencode", model)).toEqual([
				"--model",
				model,
			]);
		}
	});

	it("builds polygraph harness args for every supported harness", () => {
		for (const harness of ["claude", "codex", "opencode"]) {
			expect(buildAgentModelArgs("polygraph", harness)).toEqual([
				"--agent",
				harness,
			]);
		}
	});

	it("omits the polygraph harness flag when unset or unknown", () => {
		expect(buildAgentModelArgs("polygraph", undefined)).toEqual([]);
		expect(buildAgentModelArgs("polygraph", "")).toEqual([]);
		expect(buildAgentModelArgs("polygraph", "gemini")).toEqual([]);
	});
});

describe("AGENT_EFFORT_SUPPORT", () => {
	it("only references builtin presets", () => {
		const validIds = new Set<string>(BUILTIN_TERMINAL_AGENT_TYPES);
		for (const entry of AGENT_EFFORT_SUPPORT) {
			expect(validIds.has(entry.presetId)).toBe(true);
		}
	});

	it("lists at least one effort per entry", () => {
		for (const entry of AGENT_EFFORT_SUPPORT) {
			expect(entry.efforts.length).toBeGreaterThan(0);
		}
	});
});

describe("getAgentEffortSupport", () => {
	it("returns the entry for a supported preset", () => {
		expect(getAgentEffortSupport("claude", "claude-opus-5")?.effortFlag).toBe(
			"--effort",
		);
	});

	it("returns undefined for presets without effort support", () => {
		expect(getAgentEffortSupport("gemini")).toBeUndefined();
		expect(getAgentEffortSupport("superset")).toBeUndefined();
	});
});

describe("Codex picker catalog", () => {
	it("matches the installed Codex model catalog", () => {
		const support = getAgentEffortSupport("codex", "gpt-5.6-sol");
		expect(support?.defaultEffortId).toBe("low");
		expect(support?.efforts).toEqual([
			{ id: "low", label: "Low" },
			{ id: "medium", label: "Medium" },
			{ id: "high", label: "High" },
			{ id: "xhigh", label: "Extra High" },
			{ id: "max", label: "Max" },
			{ id: "ultra", label: "Ultra" },
		]);
	});
});

describe("buildAgentEffortArgs", () => {
	it("builds Antigravity model and runtime effort flags", () => {
		expect(
			buildAgentModelArgs("antigravity", "gemini-3.6-flash-high", undefined, [
				"gemini-3.6-flash-high",
			]),
		).toEqual(["--model", "gemini-3.6-flash-high"]);
		expect(
			buildAgentEffortArgs("antigravity", "medium", "gemini-3.6-flash-high", {
				defaultEffortId: "high",
				efforts: [
					{ id: "low", label: "Low" },
					{ id: "medium", label: "Medium" },
					{ id: "high", label: "High" },
				],
			}),
		).toEqual(["--effort", "medium"]);
	});

	it("accepts reasoning levels discovered with a runtime model", () => {
		expect(
			buildAgentEffortArgs("codex", "xhigh", "gpt-6-codex", {
				defaultEffortId: "medium",
				efforts: [
					{ id: "medium", label: "Medium" },
					{ id: "xhigh", label: "Extra High" },
				],
			}),
		).toEqual(["-c", "model_reasoning_effort=xhigh"]);
	});

	it("builds flag + value tokens", () => {
		expect(buildAgentEffortArgs("claude", "high", "claude-opus-5")).toEqual([
			"--effort",
			"high",
		]);
	});

	it("prefixes the value for codex config overrides", () => {
		expect(buildAgentEffortArgs("codex", "high", "gpt-5.6-sol")).toEqual([
			"-c",
			"model_reasoning_effort=high",
		]);
		expect(buildAgentEffortArgs("codex", "ultra", "gpt-5.6-sol")).toEqual([
			"-c",
			"model_reasoning_effort=ultra",
		]);
	});

	it("returns [] when no effort is set", () => {
		expect(buildAgentEffortArgs("claude", undefined)).toEqual([]);
		expect(buildAgentEffortArgs("claude", "")).toEqual([]);
	});

	it("returns [] for unsupported presets", () => {
		expect(buildAgentEffortArgs("gemini", "high")).toEqual([]);
	});

	it("returns [] for effort ids outside the preset's curated list", () => {
		expect(buildAgentEffortArgs("claude", "bogus", "claude-opus-5")).toEqual(
			[],
		);
		expect(buildAgentEffortArgs("copilot", "max")).toEqual([]);
	});
});

describe("Claude model traits", () => {
	it("only exposes Fast Mode on supported Opus models", () => {
		expect(
			buildAgentSpeedArgs("claude", "fast", "claude-opus-4-8"),
		).not.toEqual([]);
		expect(buildAgentSpeedArgs("claude", "fast", "claude-sonnet-4-6")).toEqual(
			[],
		);
	});

	it("resolves model-specific reasoning defaults and levels", () => {
		expect(
			getAgentEffortSupport("claude", "claude-opus-4-7")?.defaultEffortId,
		).toBe("xhigh");
		expect(getAgentEffortSupport("claude", "claude-haiku-4-5")).toMatchObject({
			label: "Thinking",
			defaultEffortId: "off",
			efforts: [
				{ id: "off", label: "Off" },
				{ id: "on", label: "On" },
			],
		});
	});

	it("normalizes Claude advanced modes for its CLI", () => {
		expect(
			buildAgentEffortArgs("claude", "ultracode", "claude-opus-5"),
		).toEqual(["--effort", "xhigh"]);
		expect(
			getAgentEffortSupport("claude", "claude-opus-5")?.efforts.some(
				(option) => option.id === "ultrathink",
			),
		).toBe(false);
	});

	it("adds the explicit 1M suffix only to models with context support", () => {
		expect(buildAgentModelArgs("claude", "claude-opus-5", "1m")).toEqual([
			"--model",
			"claude-opus-5[1m]",
		]);
		expect(buildAgentModelArgs("claude", "claude-opus-4-8", "1m")).toEqual([
			"--model",
			"claude-opus-4-8",
		]);
		expect(
			getAgentContextWindowSupport("claude", "claude-sonnet-4-6")
				?.defaultContextWindowId,
		).toBe("200k");
	});
});

describe("buildAgentModelEnv (vibe)", () => {
	it("returns VIBE_ACTIVE_MODEL for a valid vibe model", () => {
		expect(buildAgentModelEnv("vibe", "mistral-medium-3.5")).toEqual({
			VIBE_ACTIVE_MODEL: "mistral-medium-3.5",
		});
	});
	it("returns {} for an unknown model id (degrade to Vibe default)", () => {
		expect(buildAgentModelEnv("vibe", "not-a-model")).toEqual({});
	});
	it("returns {} when no model is selected", () => {
		expect(buildAgentModelEnv("vibe", undefined)).toEqual({});
	});
	it("returns {} for a preset without modelEnv", () => {
		expect(buildAgentModelEnv("claude", "opus")).toEqual({});
	});
	it("keeps buildAgentModelArgs empty for vibe (no --model flag)", () => {
		expect(buildAgentModelArgs("vibe", "mistral-medium-3.5")).toEqual([]);
	});
	it("exposes a vibe model catalog", () => {
		expect(getAgentModelSupport("vibe")?.models.map((m) => m.id)).toEqual([
			"mistral-medium-3.5",
			"devstral-small",
		]);
	});
});
