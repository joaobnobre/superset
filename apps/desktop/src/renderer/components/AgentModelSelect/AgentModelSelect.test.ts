import { describe, expect, test } from "bun:test";
// biome-ignore lint/style/noRestrictedImports: regression test inspects the component source
import { readFileSync } from "node:fs";
// biome-ignore lint/style/noRestrictedImports: regression test resolves the colocated source
import { join } from "node:path";

describe("AgentModelSelect", () => {
	test("can omit the synthetic default and fall back to the first model", () => {
		const source = readFileSync(
			join(import.meta.dir, "AgentModelSelect.tsx"),
			"utf8",
		);

		expect(source).toContain("includeDefault?: boolean");
		expect(source).toContain("if (includeDefault) return DEFAULT_MODEL_VALUE");
		expect(source).toContain("return models[0]?.id");
		expect(source).toContain("{includeDefault && (");
	});
});
