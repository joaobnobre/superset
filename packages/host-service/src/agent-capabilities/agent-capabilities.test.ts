import { beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	AgentCapabilityProbeAbortedError,
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
	runCommand,
} from "./agent-capabilities";

const nodeErrorSchema = z.object({ code: z.string() });

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
				reasoning: {
					state: "supported",
					defaultId: "high",
					options: [
						{ id: "low", label: "Low" },
						{ id: "medium", label: "Medium" },
						{ id: "high", label: "High" },
					],
				},
			},
			{
				id: "gemini-3.1-pro-high",
				label: "Gemini 3.1 Pro",
				reasoning: {
					state: "supported",
					defaultId: "high",
					options: [
						{ id: "low", label: "Low" },
						{ id: "high", label: "High" },
					],
				},
			},
			{
				id: "claude-sonnet-4-6",
				label: "Claude Sonnet 4.6",
				reasoning: { state: "unsupported" },
			},
			{
				id: "gpt-oss-120b-medium",
				label: "GPT OSS 120b Medium",
				reasoning: { state: "unknown" },
			},
		]);
	});

	test("keeps only models returned for the authenticated Copilot account", () => {
		expect(
			mapCopilotModels([
				{ id: "auto", name: "Auto" },
				{
					id: "no-reasoning",
					name: "No Reasoning",
					supportedReasoningEfforts: [],
				},
				{
					id: "gpt-test",
					name: "GPT Test",
					defaultReasoningEffort: "medium",
					supportedReasoningEfforts: ["low", "medium", "high"],
				},
			]),
		).toEqual([
			{ id: "auto", label: "Auto", reasoning: { state: "unknown" } },
			{
				id: "no-reasoning",
				label: "No Reasoning",
				reasoning: { state: "unsupported" },
			},
			{
				id: "gpt-test",
				label: "GPT Test",
				reasoning: {
					state: "supported",
					defaultId: "medium",
					options: [
						{ id: "low", label: "Low" },
						{ id: "medium", label: "Medium" },
						{ id: "high", label: "High" },
					],
				},
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
				reasoning: {
					state: "supported",
					defaultId: "medium",
					options: [
						{ id: "low", label: "Low" },
						{ id: "xhigh", label: "Extra High" },
					],
				},
			},
			{
				id: "gpt-5-codex",
				label: "GPT-5 Codex",
				provider: "Legacy Models",
				reasoning: { state: "unknown" },
			},
		]);
	});

	test("normalizes line-based CLI model discovery", () => {
		expect(
			parseLineModels(
				"anthropic/claude-opus-5\nopenai/gpt-5.6-sol\nanthropic/claude-opus-5\n",
			),
		).toEqual([
			{
				id: "anthropic/claude-opus-5",
				label: "Claude Opus 5",
				reasoning: { state: "unknown" },
			},
			{
				id: "openai/gpt-5.6-sol",
				label: "GPT-5.6 Sol",
				reasoning: { state: "unknown" },
			},
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
			{
				id: "grok-4.6",
				label: "Grok 4.6",
				reasoning: { state: "unknown" },
			},
			{
				id: "grok-4.5",
				label: "Grok 4.5",
				reasoning: { state: "unknown" },
			},
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
				reasoning: { state: "unknown" },
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
				reasoning: { state: "unknown" },
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
				reasoning: {
					state: "supported",
					options: [
						{ id: "off", label: "Off" },
						{ id: "minimal", label: "Minimal" },
						{ id: "low", label: "Low" },
						{ id: "medium", label: "Medium" },
						{ id: "high", label: "High" },
						{ id: "xhigh", label: "Extra High" },
						{ id: "max", label: "Max" },
					],
				},
			},
		]);
	});

	test("distinguishes Pi unsupported and unknown reasoning metadata", () => {
		const response = (
			models: Array<{ id: string; provider: string; reasoning?: boolean }>,
		) =>
			JSON.stringify({
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models },
			});
		expect(
			parsePiRpcModels(
				response([
					{ id: "plain", provider: "test", reasoning: false },
					{ id: "undocumented", provider: "test" },
				]),
			).map((model) => model.reasoning),
		).toEqual([{ state: "unsupported" }, { state: "unknown" }]);
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
				reasoning: {
					state: "supported",
					options: [
						{ id: "low", label: "Low" },
						{ id: "high", label: "High" },
					],
				},
			},
			{
				id: "openrouter/qwen/qwen3-coder",
				label: "Qwen3 Coder",
				provider: "OpenRouter",
				reasoning: { state: "unsupported" },
			},
		]);
	});

	test("keeps slug-only OpenCode reasoning metadata unknown", () => {
		expect(parseOpenCodeModels("anthropic/claude-sonnet-4-6")).toEqual([
			{
				id: "anthropic/claude-sonnet-4-6",
				label: "Claude Sonnet 4 6",
				provider: "Anthropic",
				reasoning: { state: "unknown" },
			},
		]);
	});

	test("rejects malformed non-empty Codex reasoning options", () => {
		expect(
			parseCodexModelsCache(
				JSON.stringify({
					models: [
						{
							slug: "bad-model",
							supported_reasoning_levels: [{ effort: 42 }],
						},
					],
				}),
			),
		).toEqual([]);
	});

	test("treats an explicit empty Codex reasoning list as unsupported", () => {
		expect(
			parseCodexModelsCache(
				JSON.stringify({
					models: [{ slug: "plain-model", supported_reasoning_levels: [] }],
				}),
			)[0]?.reasoning,
		).toEqual({ state: "unsupported" });
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
			errorKind: "missing_executable",
		});
	});

	test("classifies process and parse failures without exposing raw output", async () => {
		const directory = await mkdtemp(join(tmpdir(), "superset-agent-errors-"));
		const processFailure = join(directory, "process-failure");
		const parseFailure = join(directory, "parse-failure");
		await writeFile(
			processFailure,
			"#!/bin/sh\nprintf 'sensitive' >&2\nexit 2\n",
		);
		await writeFile(parseFailure, "#!/bin/sh\nexit 0\n");
		await Promise.all([
			chmod(processFailure, 0o755),
			chmod(parseFailure, 0o755),
		]);
		try {
			const [processSnapshot, parseSnapshot] = await Promise.all([
				inspectAgentCapability(
					{
						id: "opencode-process-failure",
						presetId: "opencode",
						command: processFailure,
						env: {},
					},
					{ force: true },
				),
				inspectAgentCapability(
					{
						id: "antigravity-parse-failure",
						presetId: "antigravity",
						command: parseFailure,
						env: {},
					},
					{ force: true },
				),
			]);
			expect(processSnapshot).toMatchObject({
				errorKind: "process_failure",
			});
			expect(processSnapshot.message).not.toContain("sensitive");
			expect(parseSnapshot).toMatchObject({ errorKind: "parse_failure" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
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

	test("coalesces concurrent probes for the same config revision", async () => {
		const directory = await mkdtemp(join(tmpdir(), "superset-agent-dedupe-"));
		const executable = join(directory, "opencode-test");
		const logPath = join(directory, "invocations.log");
		await writeFile(
			executable,
			'#!/bin/sh\nprintf "x\\n" >> "$LOG_PATH"\n[ "$1" = "models" ] && printf "provider/model-1\\n"\n[ "$1" = "--version" ] && printf "1.0.0\\n"\n',
		);
		await chmod(executable, 0o755);
		try {
			const config = {
				id: "opencode-dedupe-test",
				presetId: "opencode",
				command: executable,
				env: { LOG_PATH: logPath },
				configRevision: 7,
			};
			const [first, second] = await Promise.all([
				inspectAgentCapability(config, { force: true }),
				inspectAgentCapability(config, { force: true }),
			]);
			expect(second).toEqual(first);
			expect((await readFile(logPath, "utf8")).trim().split("\n")).toHaveLength(
				3,
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("cancels spawned CLI processes when the probe signal aborts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "superset-agent-cancel-"));
		const executable = join(directory, "opencode-test");
		const logPath = join(directory, "invocations.log");
		await writeFile(
			executable,
			'#!/bin/sh\nprintf "x\\n" >> "$LOG_PATH"\nexec sleep 10\n',
		);
		await chmod(executable, 0o755);
		const controller = new AbortController();
		try {
			const probe = inspectAgentCapability(
				{
					id: "opencode-cancel-test",
					presetId: "opencode",
					command: executable,
					env: { LOG_PATH: logPath },
					configRevision: 1,
				},
				{ force: true, signal: controller.signal },
			);
			for (let attempt = 0; attempt < 100; attempt += 1) {
				try {
					if ((await readFile(logPath, "utf8")).length > 0) break;
				} catch {
					// The child has not started yet.
				}
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
			}

			controller.abort();

			await expect(probe).rejects.toBeInstanceOf(
				AgentCapabilityProbeAbortedError,
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("finishes Pi discovery as soon as its long-lived RPC returns models", async () => {
		const directory = await mkdtemp(join(tmpdir(), "superset-pi-probe-"));
		const executable = join(directory, "pi-test");
		const argsPath = join(directory, "pi-args");
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
			`#!/bin/sh\nprintf '%s\\n' "$*" > '${argsPath}'\nprintf '%s\\n' '${response}'\nwhile :; do sleep 1; done\n`,
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
						reasoning: { state: "unsupported" },
					},
				],
			});
			expect(await readFile(argsPath, "utf8")).toContain("--no-extensions");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("proves no orphan process remains after timeout for a process ignoring SIGTERM", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "superset-agent-ignore-term-timeout-"),
		);
		try {
			const { executable, parentPidFile, descendantPidFile } =
				await writeIgnoreTermTreeScript(directory);
			const startedAt = Date.now();
			const result = await runCommand(
				executable,
				[],
				{},
				200,
				undefined,
				undefined,
				undefined,
				100,
			);
			expect(result.timedOut).toBe(true);
			expect(Date.now() - startedAt).toBeLessThan(2_000);
			const parentPid = await waitForPidFile(parentPidFile);
			const descendantPid = await waitForPidFile(descendantPidFile);
			await expectPidGone(parentPid);
			await expectPidGone(descendantPid);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("proves no orphan process remains after abort for a process ignoring SIGTERM", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "superset-agent-ignore-term-abort-"),
		);
		const controller = new AbortController();
		try {
			const { executable, parentPidFile, descendantPidFile } =
				await writeIgnoreTermTreeScript(directory);
			const startedAt = Date.now();
			const promise = runCommand(
				executable,
				[],
				{},
				10_000,
				undefined,
				undefined,
				controller.signal,
				100,
			);
			const parentPid = await waitForPidFile(parentPidFile);
			const descendantPid = await waitForPidFile(descendantPidFile);
			controller.abort();
			await expect(promise).rejects.toBeInstanceOf(
				AgentCapabilityProbeAbortedError,
			);
			expect(Date.now() - startedAt).toBeLessThan(2_000);
			await expectPidGone(parentPid);
			await expectPidGone(descendantPid);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("proves no orphan process remains after completion trigger for a process ignoring SIGTERM", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "superset-agent-ignore-term-complete-"),
		);
		try {
			const { executable, parentPidFile, descendantPidFile } =
				await writeIgnoreTermTreeScript(directory, 'printf "READY_TRIGGER\\n"');
			const startedAt = Date.now();
			const result = await runCommand(
				executable,
				[],
				{},
				10_000,
				undefined,
				(stdout) => stdout.includes("READY_TRIGGER"),
				undefined,
				100,
			);
			expect(result.timedOut).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(Date.now() - startedAt).toBeLessThan(2_000);
			const parentPid = await waitForPidFile(parentPidFile);
			const descendantPid = await waitForPidFile(descendantPidFile);
			await expectPidGone(parentPid);
			await expectPidGone(descendantPid);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("does not settle until the child closes and its ignore-TERM descendant is gone", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "superset-agent-close-order-"),
		);
		const executable = join(directory, "stub-slow-close");
		const parentPidFile = join(directory, "parent.pid");
		const descendantPidFile = join(directory, "descendant.pid");
		await writeFile(
			executable,
			`#!/bin/sh
echo $$ > "${parentPidFile}"
(
  trap '' TERM
  echo $$ > "${descendantPidFile}"
  while true; do
    sleep 1
  done
) &
while [ ! -s "${descendantPidFile}" ]; do
  sleep 0.05
done
printf 'PREFIX_OUTPUT\\n'
trap 'dd if=/dev/zero bs=1024 count=32 2>/dev/null; printf "DRAINED_OUTPUT_TOKEN\\n"; exit 0' TERM
while true; do
  sleep 1
done
`,
		);
		await chmod(executable, 0o755);

		const controller = new AbortController();
		try {
			const promise = runCommand(
				executable,
				[],
				{},
				10_000,
				undefined,
				undefined,
				controller.signal,
				500,
			);
			const parentPid = await waitForPidFile(parentPidFile);
			const descendantPid = await waitForPidFile(descendantPidFile);
			controller.abort();
			await expect(promise).rejects.toBeInstanceOf(
				AgentCapabilityProbeAbortedError,
			);
			await expectPidGone(parentPid);
			await expectPidGone(descendantPid);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("captures the full stdout payload after a natural close", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "superset-agent-natural-drain-"),
		);
		const executable = join(directory, "stub-natural-drain");
		const payloadPath = join(directory, "payload.txt");
		const payload = `${"x".repeat(64 * 1024)}\nNATURAL_FINAL_SENTINEL\n`;
		await writeFile(payloadPath, payload);
		await writeFile(executable, `#!/bin/sh\ncat "${payloadPath}"\n`);
		await chmod(executable, 0o755);
		try {
			const result = await runCommand(executable, [], {}, 4_000);
			expect(result.timedOut).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.endsWith("NATURAL_FINAL_SENTINEL\n")).toBe(true);
			expect(result.stdout.length).toBe(payload.length);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("includes post-SIGTERM stdout that lands before stdio close", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "superset-agent-term-drain-"),
		);
		const executable = join(directory, "stub-term-drain");
		await writeFile(
			executable,
			`#!/bin/sh
trap 'printf "YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY\\nDRAINED_OUTPUT_TOKEN\\n"; exit 0' TERM
printf 'PREFIX_OUTPUT\\nREADY_TRIGGER\\n'
while true; do
  sleep 1
done
`,
		);
		await chmod(executable, 0o755);
		try {
			const result = await runCommand(
				executable,
				[],
				{},
				10_000,
				undefined,
				(stdout) => stdout.includes("READY_TRIGGER"),
				undefined,
				250,
			);
			expect(result.timedOut).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("PREFIX_OUTPUT");
			expect(result.stdout).toContain("READY_TRIGGER");
			expect(result.stdout).toContain("DRAINED_OUTPUT_TOKEN");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const parsed = nodeErrorSchema.safeParse(error);
		return !parsed.success || parsed.data.code !== "ESRCH";
	}
}

async function waitForPidFile(
	pidFile: string,
	timeoutMs = 1_000,
): Promise<number> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
			if (pid > 0) return pid;
		} catch {
			// Not written yet.
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	}
	throw new Error(`timed out waiting for pid file ${pidFile}`);
}

async function expectPidGone(pid: number, timeoutMs = 500): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (!isPidAlive(pid)) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	}
	expect(isPidAlive(pid)).toBe(false);
}

async function writeIgnoreTermTreeScript(
	directory: string,
	extraPrelude = "",
): Promise<{
	executable: string;
	parentPidFile: string;
	descendantPidFile: string;
}> {
	const executable = join(directory, "stub-ignore-sigterm");
	const parentPidFile = join(directory, "parent.pid");
	const descendantPidFile = join(directory, "descendant.pid");
	await writeFile(
		executable,
		`#!/bin/sh
trap '' TERM
echo $$ > "${parentPidFile}"
(
  trap '' TERM
  echo $$ > "${descendantPidFile}"
  while true; do
    sleep 1
  done
) &
while [ ! -s "${descendantPidFile}" ]; do
  sleep 0.05
done
${extraPrelude}
while true; do
  sleep 1
done
`,
	);
	await chmod(executable, 0o755);
	return { executable, parentPidFile, descendantPidFile };
}
