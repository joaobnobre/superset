import { describe, expect, test } from "bun:test";
import { reorderDisplayedPresetIds } from "./reorderDisplayedPresetIds";

describe("reorderDisplayedPresetIds", () => {
	test("hidden-before: displayed indices skip a missing-executable preset at the front", () => {
		const next = reorderDisplayedPresetIds({
			orderedIds: ["hidden", "a", "b"],
			displayedIds: ["a", "b"],
			fromIndex: 0,
			toIndex: 1,
		});
		expect(next).toEqual(["hidden", "b", "a"]);
		expect(next.filter((id) => id !== "hidden")).toEqual(["b", "a"]);
	});

	test("hidden-between: displayed indices skip a missing-executable preset in the middle", () => {
		const next = reorderDisplayedPresetIds({
			orderedIds: ["a", "hidden", "b"],
			displayedIds: ["a", "b"],
			fromIndex: 0,
			toIndex: 1,
		});
		expect(next).toEqual(["b", "hidden", "a"]);
		expect(next.filter((id) => id !== "hidden")).toEqual(["b", "a"]);
	});

	test("keeps hidden ids in place when displayed items are already ordered", () => {
		expect(
			reorderDisplayedPresetIds({
				orderedIds: ["hidden", "a", "hidden-2", "b"],
				displayedIds: ["a", "b"],
				fromIndex: 0,
				toIndex: 0,
			}),
		).toEqual(["hidden", "a", "hidden-2", "b"]);
	});

	test("returns the original order when displayed indices are out of range", () => {
		expect(
			reorderDisplayedPresetIds({
				orderedIds: ["hidden", "a", "b"],
				displayedIds: ["a", "b"],
				fromIndex: 0,
				toIndex: 4,
			}),
		).toEqual(["hidden", "a", "b"]);
	});
});
