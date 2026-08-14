import { describe, expect, test } from "bun:test";
// biome-ignore lint/style/noRestrictedImports: regression test inspects the component source
import { readFileSync } from "node:fs";
// biome-ignore lint/style/noRestrictedImports: regression test resolves the colocated source
import { join } from "node:path";

describe("AgentSelect", () => {
	test("keeps edge agents below the native draggable titlebar", () => {
		const source = readFileSync(
			join(import.meta.dir, "AgentSelect.tsx"),
			"utf8",
		);

		expect(source).toContain("collisionPadding={48}");
	});

	test("normalizes the optically smaller Codex icon", () => {
		const source = readFileSync(
			join(import.meta.dir, "AgentSelect.tsx"),
			"utf8",
		);

		expect(source).toContain('iconId === "codex"');
		expect(source).toContain('"scale-[1.35]"');
	});

	test("uses the native select disabled state for unavailable agents", () => {
		const source = readFileSync(
			join(import.meta.dir, "AgentSelect.tsx"),
			"utf8",
		);

		expect(source).toContain("disabled={agent.disabled}");
		expect(source).toContain("agents.filter((agent) => !agent.disabled)");
	});

	test("stays controlled while agent capabilities are loading", () => {
		const source = readFileSync(
			join(import.meta.dir, "AgentSelect.tsx"),
			"utf8",
		);

		expect(source).toContain('value={selectedValue ?? ""}');
	});
});
