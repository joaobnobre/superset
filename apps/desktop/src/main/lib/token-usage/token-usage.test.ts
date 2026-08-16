import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectTokenUsageSnapshot,
	parseTokenUsageSnapshotLine,
} from "./token-usage";

describe("parseTokenUsageSnapshotLine", () => {
	test("normalizes every available Codex rate-limit window", () => {
		const snapshot = parseTokenUsageSnapshotLine(
			JSON.stringify({
				timestamp: "2026-08-16T17:00:00.000Z",
				payload: {
					rate_limits: {
						primary: {
							used_percent: 32.4,
							window_minutes: 300,
							resets_at: 1_787_000_000,
						},
						secondary: {
							used_percent: 88,
							window_minutes: 10_080,
							resets_at: 1_787_100_000,
						},
					},
				},
			}),
			0,
		);

		expect(snapshot?.updatedAt).toBe(Date.parse("2026-08-16T17:00:00.000Z"));
		expect(snapshot?.windows).toEqual([
			{
				id: "primary",
				label: "5h",
				windowMinutes: 300,
				usedPercent: 32.4,
				resetsAt: 1_787_000_000_000,
			},
			{
				id: "secondary",
				label: "1w",
				windowMinutes: 10_080,
				usedPercent: 88,
				resetsAt: 1_787_100_000_000,
			},
		]);
	});

	test("ignores malformed and incomplete rate-limit records", () => {
		expect(parseTokenUsageSnapshotLine("not json", 0)).toBeNull();
		expect(
			parseTokenUsageSnapshotLine(
				JSON.stringify({ payload: { rate_limits: { primary: {} } } }),
				0,
			),
		).toBeNull();
	});
});

describe("collectTokenUsageSnapshot", () => {
	test("aggregates and deduplicates Codex and Claude transcripts", async () => {
		const root = await mkdtemp(join(tmpdir(), "superset-token-usage-"));
		try {
			const claudeRoot = join(root, "claude");
			const codexRoot = join(root, "codex");
			await mkdir(join(claudeRoot, "projects", "fixture"), { recursive: true });
			await mkdir(codexRoot, { recursive: true });
			const timestamp = "2026-08-16T12:00:00.000Z";
			const claudeRecord = JSON.stringify({
				type: "assistant",
				timestamp,
				requestId: "request-1",
				message: {
					id: "message-1",
					model: "claude-sonnet-4-6",
					usage: {
						input_tokens: 100,
						output_tokens: 20,
						cache_read_input_tokens: 50,
						cache_creation_input_tokens: 10,
					},
				},
			});
			await writeFile(
				join(claudeRoot, "projects", "fixture", "session.jsonl"),
				`${claudeRecord}\n${claudeRecord}\n`,
			);
			await writeFile(
				join(codexRoot, "session.jsonl"),
				[
					JSON.stringify({
						timestamp,
						type: "session_meta",
						payload: { id: "codex-session" },
					}),
					JSON.stringify({
						timestamp,
						type: "turn_context",
						payload: { model: "gpt-5.6-sol" },
					}),
					JSON.stringify({
						timestamp,
						type: "event_msg",
						payload: {
							type: "token_count",
							info: {
								last_token_usage: {
									input_tokens: 1_000,
									cached_input_tokens: 200,
									output_tokens: 100,
									reasoning_output_tokens: 30,
								},
							},
							rate_limits: {
								primary: {
									used_percent: 40,
									window_minutes: 300,
									resets_at: 1_787_000_000,
								},
								secondary: {
									used_percent: 75,
									window_minutes: 10_080,
									resets_at: 1_787_100_000,
								},
							},
						},
					}),
				].join("\n"),
			);

			const snapshot = await collectTokenUsageSnapshot({
				claudeRoot,
				codexRoot,
				nowMs: Date.parse("2026-08-16T13:00:00.000Z"),
			});
			const claude = snapshot.providers.find(
				(provider) => provider.provider === "claude",
			);
			const codex = snapshot.providers.find(
				(provider) => provider.provider === "codex",
			);

			expect(claude?.messages).toBe(1);
			expect(claude?.totalTokens).toBe(180);
			expect(claude?.models[0]?.pricingKnown).toBe(true);
			expect(claude?.costUsd).toBeGreaterThan(0);
			expect(codex?.totalTokens).toBe(1_100);
			expect(codex?.tokens.reasoningTokens).toBe(30);
			expect(codex?.windows[0]?.label).toBe("5h");
			expect(codex?.costUsd).toBeGreaterThan(0);
			expect(snapshot.period.resetBased).toBe(false);
			expect(snapshot.period.label).toBe("Last 7 days");
			expect(snapshot.period.endAt).toBe(
				Date.parse("2026-08-16T13:00:00.000Z"),
			);
			expect(codex?.activeDays).toBe(1);
			expect(codex?.days).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
