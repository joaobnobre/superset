import { beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearAgentCapabilityCache,
	inspectAgentCapability,
	mapCopilotModels,
	parseAntigravityModels,
	parseCodexModelsCache,
	parseGrokModels,
	parseKimiProviderModels,
	parseLineModels,
	parseOpenCodeModels,
	parsePiModels,
	parsePiRpcModels,
} from "./agent-capabilities";

beforeEach(() => clearAgentCapabilityCache());

describe("agent capabilities", () => {
	test("groups Antigravity effort variants without inventing unsupported levels", () => {
		expect(
			parseAntigravityModels(
				[
					"gemini-3.6-flash-high",
					"gemini-3.6-flash-medium",
					"gemini-3.6-flash-low",
					"gemini-3.1-pro-high",
					"gemini-3.1-pro-low",
					"claude-sonnet-4-6",
					"gpt-oss-120b-medium",
				].join("\n"),
			),
		).toEqual([
			{
				id: "gemini-3.6-flash-high",
				label: "Gemini 3.6 Flash",
				defaultEffortId: "high",
				efforts: [
					{ id: "low", label: "Low" },
					{ id: "medium", label: "Medium" },
					{ id: "high", label: "High" },
				],
			},
			{
				id: "gemini-3.1-pro-high",
				label: "Gemini 3.1 Pro",
				defaultEffortId: "high",
				efforts: [
					{ id: "low", label: "Low" },
					{ id: "high", label: "High" },
				],
			},
			{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
			{ id: "gpt-oss-120b-medium", label: "GPT OSS 120b Medium" },
		]);
	});

	test("keeps only models returned for the authenticated Copilot account", () => {
		expect(
			mapCopilotModels([
				{ id: "auto", name: "Auto" },
				{
					id: "gpt-test",
					name: "GPT Test",
					defaultReasoningEffort: "medium",
					supportedReasoningEfforts: ["low", "medium", "high"],
				},
			]),
		).toEqual([
			{ id: "auto", label: "Auto", efforts: [] },
			{
				id: "gpt-test",
				label: "GPT Test",
				defaultEffortId: "medium",
				efforts: [
					{ id: "low", label: "Low" },
					{ id: "medium", label: "Medium" },
					{ id: "high", label: "High" },
				],
			},
		]);
	});

	test("reads versioned models and reasoning levels from the Codex cache", () => {
		expect(
			parseCodexModelsCache(
				JSON.stringify({
					models: [
						{
							slug: "gpt-6-codex-wm",
							display_name: "GPT-6-Codex-WM",
							visibility: "hide",
						},
						{
							slug: "gpt-6-codex",
							display_name: "GPT-6-Codex",
							visibility: "list",
							default_reasoning_level: "medium",
							supported_reasoning_levels: [
								{ effort: "low" },
								{ effort: "xhigh" },
							],
						},
						{
							slug: "gpt-5-codex",
							display_name: "GPT-5-Codex",
							visibility: "list",
							upgrade: "gpt-6-codex",
						},
					],
				}),
			),
		).toEqual([
			{
				id: "gpt-6-codex",
				label: "GPT-6 Codex",
				provider: "Current Models",
				defaultEffortId: "medium",
				efforts: [
					{ id: "low", label: "Low" },
					{ id: "xhigh", label: "Extra High" },
				],
			},
			{
				id: "gpt-5-codex",
				label: "GPT-5 Codex",
				provider: "Legacy Models",
			},
		]);
	});

	test("normalizes line-based CLI model discovery", () => {
		expect(
			parseLineModels(
				"anthropic/claude-opus-5\nopenai/gpt-5.6-sol\nanthropic/claude-opus-5\n",
			),
		).toEqual([
			{ id: "anthropic/claude-opus-5", label: "Claude Opus 5" },
			{ id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol" },
		]);
	});

	test("reads only account-available models from Grok's authenticated list", () => {
		expect(
			parseGrokModels(
				[
					"You are logged in with grok.com.",
					"",
					"Default model: grok-4.6",
					"",
					"Available models:",
					"  * grok-4.6 (default)",
					"  - grok-4.5",
				].join("\n"),
			),
		).toEqual([
			{ id: "grok-4.6", label: "Grok 4.6" },
			{ id: "grok-4.5", label: "Grok 4.5" },
		]);
	});

	test("reads Kimi's configured provider model aliases", () => {
		expect(
			parseKimiProviderModels(
				JSON.stringify({
					providers: { moonshot: { name: "Moonshot" } },
					models: {
						kimi_default: {
							name: "Kimi Default",
							provider: "moonshot",
						},
					},
				}),
			),
		).toEqual([
			{
				id: "kimi_default",
				label: "Kimi Default",
				provider: "Moonshot",
			},
		]);
		expect(parseKimiProviderModels('{"providers":{},"models":{}}')).toEqual([]);
	});

	test("reads Pi's authenticated provider and model table", () => {
		expect(
			parsePiModels(
				[
					"provider      model                context  max-out  thinking  images",
					"openai-codex  gpt-5.6-sol          272K     128K     yes       yes",
				].join("\n"),
			),
		).toEqual([
			{
				id: "openai-codex/gpt-5.6-sol",
				label: "GPT-5.6 Sol",
				provider: "OpenAI Codex",
			},
		]);
	});

	test("reads Pi model-specific reasoning levels from RPC", () => {
		expect(
			parsePiRpcModels(
				JSON.stringify({
					type: "response",
					command: "get_available_models",
					success: true,
					data: {
						models: [
							{
								id: "gpt-5.6-sol",
								name: "GPT-5.6 Sol",
								provider: "openai-codex",
								reasoning: true,
								thinkingLevelMap: {
									minimal: "low",
									xhigh: "xhigh",
									max: "max",
								},
							},
						],
					},
				}),
			),
		).toEqual([
			{
				id: "openai-codex/gpt-5.6-sol",
				label: "GPT-5.6 Sol",
				provider: "OpenAI Codex",
				efforts: [
					{ id: "off", label: "Off" },
					{ id: "minimal", label: "Minimal" },
					{ id: "low", label: "Low" },
					{ id: "medium", label: "Medium" },
					{ id: "high", label: "High" },
					{ id: "xhigh", label: "Extra High" },
					{ id: "max", label: "Max" },
				],
			},
		]);
	});

	test("keeps OpenCode's authoritative model names from verbose output", () => {
		expect(
			parseOpenCodeModels(
				[
					"anthropic/claude-sonnet-4-6",
					JSON.stringify({
						id: "claude-sonnet-4-6",
						providerID: "anthropic",
						name: "Claude Sonnet 4.6",
						variants: {
							low: { reasoningEffort: "low" },
							high: { reasoningEffort: "high" },
						},
					}),
					"openrouter/qwen/qwen3-coder",
					JSON.stringify({
						id: "qwen/qwen3-coder",
						providerID: "openrouter",
						name: "Qwen3 Coder",
					}),
				].join("\n"),
			),
		).toEqual([
			{
				id: "anthropic/claude-sonnet-4-6",
				label: "Claude Sonnet 4.6",
				provider: "Anthropic",
				efforts: [
					{ id: "low", label: "Low" },
					{ id: "high", label: "High" },
				],
			},
			{
				id: "openrouter/qwen/qwen3-coder",
				label: "Qwen3 Coder",
				provider: "OpenRouter",
			},
		]);
	});

	test("marks missing configured agents unavailable", async () => {
		const snapshot = await inspectAgentCapability({
			id: "missing-agent",
			presetId: "custom",
			command: "superset-agent-that-does-not-exist",
			env: {},
		});

		expect(snapshot).toMatchObject({
			status: "unavailable",
			installed: false,
			models: [],
		});
	});

	test("keeps an installed but unverified agent visible as unavailable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "superset-droid-probe-"));
		const executable = join(directory, "droid-test");
		await writeFile(executable, "#!/bin/sh\nexit 0\n");
		await chmod(executable, 0o755);
		try {
			const snapshot = await inspectAgentCapability(
				{
					id: "droid-test",
					presetId: "droid",
					command: executable,
					env: {},
				},
				{ force: true },
			);
			expect(snapshot).toMatchObject({
				status: "unavailable",
				installed: true,
				auth: "unknown",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("does not pass Electron's Node mode into agent CLIs", async () => {
		const directory = await mkdtemp(join(tmpdir(), "superset-agent-probe-"));
		const executable = join(directory, "opencode-test");
		await writeFile(
			executable,
			'#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = "1" ] && exit 42\n[ "$1" = "models" ] && printf "provider/model-1\\n"\n',
		);
		await chmod(executable, 0o755);
		const previous = process.env.ELECTRON_RUN_AS_NODE;
		process.env.ELECTRON_RUN_AS_NODE = "1";
		try {
			const snapshot = await inspectAgentCapability(
				{
					id: "opencode-test",
					presetId: "opencode",
					command: executable,
					env: {},
				},
				{ force: true },
			);
			expect(snapshot).toMatchObject({
				status: "ready",
				modelSource: "runtime",
				models: [{ id: "provider/model-1", label: "Model 1" }],
			});
		} finally {
			if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
			else process.env.ELECTRON_RUN_AS_NODE = previous;
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("finishes Pi discovery as soon as its long-lived RPC returns models", async () => {
		const directory = await mkdtemp(join(tmpdir(), "superset-pi-probe-"));
		const executable = join(directory, "pi-test");
		const response = JSON.stringify({
			type: "response",
			command: "get_available_models",
			success: true,
			data: {
				models: [
					{
						id: "model-1",
						name: "Model 1",
						provider: "provider-1",
						reasoning: false,
					},
				],
			},
		});
		await writeFile(
			executable,
			`#!/bin/sh\nprintf '%s\\n' '${response}'\nwhile :; do sleep 1; done\n`,
		);
		await chmod(executable, 0o755);
		try {
			const startedAt = Date.now();
			const snapshot = await inspectAgentCapability(
				{
					id: "pi-test",
					presetId: "pi",
					command: executable,
					env: {},
				},
				{ force: true },
			);
			expect(Date.now() - startedAt).toBeLessThan(1_000);
			expect(snapshot).toMatchObject({
				status: "ready",
				modelSource: "runtime",
				models: [
					{
						id: "provider-1/model-1",
						label: "Model 1",
						efforts: [{ id: "off", label: "Off" }],
					},
				],
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("bypasses a slow Omarchy npx wrapper when its Pi package is cached", async () => {
		const home = await mkdtemp(join(tmpdir(), "superset-pi-wrapper-"));
		const wrapper = join(home, "pi");
		const packageRoot = join(
			home,
			".npm/_npx/cache/node_modules/@earendil-works/pi-coding-agent",
		);
		const cachedBinary = join(home, ".npm/_npx/cache/node_modules/.bin/pi");
		const response = JSON.stringify({
			type: "response",
			command: "get_available_models",
			success: true,
			data: {
				models: [
					{
						id: "model-1",
						name: "Model 1",
						provider: "provider-1",
						reasoning: false,
					},
				],
			},
		});
		await mkdir(packageRoot, { recursive: true });
		await mkdir(join(home, ".npm/_npx/cache/node_modules/.bin"), {
			recursive: true,
		});
		await writeFile(join(packageRoot, "package.json"), "{}");
		await writeFile(
			wrapper,
			'#!/bin/sh\npackage="@earendil-works/pi-coding-agent"\ncommand="pi"\nsleep 10\n',
		);
		await writeFile(cachedBinary, `#!/bin/sh\nprintf '%s\\n' '${response}'\n`);
		await chmod(wrapper, 0o755);
		await chmod(cachedBinary, 0o755);
		try {
			const startedAt = Date.now();
			const snapshot = await inspectAgentCapability(
				{
					id: "pi-wrapper-test",
					presetId: "pi",
					command: wrapper,
					env: { HOME: home },
				},
				{ force: true },
			);
			expect(Date.now() - startedAt).toBeLessThan(1_000);
			expect(snapshot).toMatchObject({
				status: "ready",
				models: [{ id: "provider-1/model-1", label: "Model 1" }],
			});
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
