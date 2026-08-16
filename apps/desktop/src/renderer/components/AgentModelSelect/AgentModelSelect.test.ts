import { describe, expect, test } from "bun:test";
import { resolveAgentModelSelectValue } from "./AgentModelSelect";

const models = [
	{ id: "model-a", label: "Model A" },
	{ id: "model-b", label: "Model B" },
];

describe("resolveAgentModelSelectValue", () => {
	test("uses a valid explicit selection", () => {
		expect(resolveAgentModelSelectValue(models, "model-b", false)).toBe(
			"model-b",
		);
	});

	test("falls back to the first model when the synthetic default is omitted", () => {
		expect(resolveAgentModelSelectValue(models, null, false)).toBe("model-a");
	});

	test("uses the synthetic default only when requested", () => {
		expect(resolveAgentModelSelectValue(models, null, true)).toBe(
			"__default_model__",
		);
	});
});
