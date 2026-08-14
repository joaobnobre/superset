import { describe, expect, test } from "bun:test";
// biome-ignore lint/style/noRestrictedImports: regression test inspects the component source
import { readFileSync } from "node:fs";
// biome-ignore lint/style/noRestrictedImports: regression test resolves the colocated source
import { join } from "node:path";

describe("WorkspaceAgentTraitsPicker", () => {
	const source = readFileSync(
		join(import.meta.dir, "WorkspaceAgentTraitsPicker.tsx"),
		"utf8",
	);

	test("uses the actual default without rendering default labels", () => {
		expect(source).toContain("defaultEffortId");
		expect(source).not.toContain(">Default<");
		expect(source).not.toContain('{ id: null, label: "Default" }');
	});

	test("keeps performance choices inside the traits popover", () => {
		expect(source).toContain("speedSupport.speeds.map");
		expect(source).toContain("onValueChange={onSpeedChange}");
		expect(source).toContain("speedSupport.label");
		expect(source).not.toContain('aria-label="Fast mode"');
		expect(source).not.toContain("aria-pressed={isFast}");
	});

	test("uses the compact popover width", () => {
		expect(source).toContain("w-44");
		expect(source).not.toContain("w-52");
	});

	test("renders model-specific context-window choices in the same popover", () => {
		expect(source).toContain("contextWindowSupport.contextWindows.map");
		expect(source).toContain("onValueChange={onContextWindowChange}");
		expect(source).toContain("Context Window");
	});
});
