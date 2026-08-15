import { describe, expect, test } from "bun:test";
import {
	EXISTING_PREFIX,
	isDiffCommentSelectionValid,
	NEW_PREFIX,
	resolveDiffCommentDefaultValue,
} from "./useDiffCommentTarget";

const sessions = [{ terminalId: "term-live" }];
const configs = [
	{ id: "cfg-ready", label: "Claude", presetId: "claude" },
	{
		id: "cfg-auth",
		label: "Codex",
		presetId: "codex",
		disabled: true,
	},
];

describe("diff comment agent target", () => {
	test("prefers a live session even when new-agent choices are disabled", () => {
		expect(resolveDiffCommentDefaultValue({ sessions, configs })).toBe(
			`${EXISTING_PREFIX}term-live`,
		);
	});

	test("defaults to the first enabled new agent when no session is alive", () => {
		expect(resolveDiffCommentDefaultValue({ sessions: [], configs })).toBe(
			`${NEW_PREFIX}cfg-ready`,
		);
	});

	test("rejects a disabled new-agent selection while keeping live sessions valid", () => {
		expect(
			isDiffCommentSelectionValid({
				value: `${NEW_PREFIX}cfg-auth`,
				sessions: [],
				configs,
			}),
		).toBe(false);
		expect(
			isDiffCommentSelectionValid({
				value: `${EXISTING_PREFIX}term-live`,
				sessions,
				configs,
			}),
		).toBe(true);
	});
});
