export function mergeCapabilityViews<
	TView extends { readonly agentId: string },
>(cached: readonly TView[], refresh: readonly TView[] | undefined): TView[] {
	if (!refresh) return cached.slice();
	const byId = new Map(cached.map((view) => [view.agentId, view]));
	for (const view of refresh) {
		byId.set(view.agentId, view);
	}
	return [...byId.values()];
}

export function resolveAgentChoicesFetched(input: {
	configsFetched: boolean;
	snapshotsFetched: boolean;
	snapshotCount: number;
	refreshEnabled: boolean;
	refreshSettled: boolean;
}): boolean {
	if (!input.configsFetched || !input.snapshotsFetched) return false;
	if (!input.refreshEnabled || input.snapshotCount > 0) return true;
	return input.refreshSettled;
}
