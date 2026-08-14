import { describe, expect, test } from "bun:test";
import { groupAgentsByAvailability } from "./useV2AgentChoices";

describe("groupAgentsByAvailability", () => {
	test("keeps manual order within ready and unavailable groups", () => {
		const result = groupAgentsByAvailability([
			{ id: "codex", label: "Codex" },
			{ id: "gemini", label: "Gemini", disabled: true },
			{ id: "claude", label: "Claude" },
			{ id: "amp", label: "Amp", disabled: true },
		]);

		expect(result.ready.map((agent) => agent.id)).toEqual(["codex", "claude"]);
		expect(result.unavailable.map((agent) => agent.id)).toEqual([
			"gemini",
			"amp",
		]);
	});
});
