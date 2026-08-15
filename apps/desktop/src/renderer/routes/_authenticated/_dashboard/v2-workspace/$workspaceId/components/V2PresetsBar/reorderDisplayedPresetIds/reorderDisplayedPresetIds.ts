export function reorderDisplayedPresetIds({
	orderedIds,
	displayedIds,
	fromIndex,
	toIndex,
}: {
	orderedIds: readonly string[];
	displayedIds: readonly string[];
	fromIndex: number;
	toIndex: number;
}): string[] {
	const displayedSet = new Set(displayedIds);
	const displayedInOrder = orderedIds.filter((id) => displayedSet.has(id));
	if (
		fromIndex < 0 ||
		fromIndex >= displayedInOrder.length ||
		toIndex < 0 ||
		toIndex >= displayedInOrder.length
	) {
		return [...orderedIds];
	}

	const nextDisplayed = [...displayedInOrder];
	const [moved] = nextDisplayed.splice(fromIndex, 1);
	if (moved === undefined) return [...orderedIds];
	nextDisplayed.splice(toIndex, 0, moved);

	let displayedCursor = 0;
	return orderedIds.map((id) =>
		displayedSet.has(id) ? (nextDisplayed[displayedCursor++] ?? id) : id,
	);
}
