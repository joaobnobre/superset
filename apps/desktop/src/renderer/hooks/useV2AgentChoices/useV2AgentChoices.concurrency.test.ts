import { afterEach, describe, expect, test } from "bun:test";
import {
	focusManager,
	QueryClient,
	QueryObserver,
} from "@tanstack/react-query";
import { hostAgentCapabilityRefreshQueryKey } from "./capabilityQueryKeys";
import type { AgentChoiceCapability } from "./useV2AgentChoices";

function capability(): AgentChoiceCapability {
	return {
		agentId: "cfg-codex",
		presetId: "codex",
		inventory: null,
		inventoryOrigin: "persisted",
		health: {
			status: "ready",
			installed: true,
			auth: "authenticated",
			checkedAt: "2026-01-01T00:00:00.000Z",
			errorKind: null,
			message: null,
		},
		healthOrigin: "persisted",
		refreshStatus: "idle",
	};
}

const CAPABILITY_PICKER_FRESHNESS_MS = 5 * 60 * 1_000;

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 1_000,
): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error("Timed out waiting for shared refresh");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("useV2AgentChoices shared refresh", () => {
	afterEach(() => {
		focusManager.setFocused(true);
	});

	test("two mounts plus focus share one stale refresh per host", async () => {
		const hostUrl = "http://workspace-host";
		const refreshCalls: string[] = [];
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.mount();
		const queryKey = hostAgentCapabilityRefreshQueryKey(hostUrl);
		const options = {
			queryKey,
			queryFn: async () => {
				refreshCalls.push("refresh");
				return [
					{
						...capability(),
						inventoryOrigin: "live" as const,
						healthOrigin: "live" as const,
					},
				];
			},
			staleTime: CAPABILITY_PICKER_FRESHNESS_MS,
			refetchOnWindowFocus: true,
		};

		const firstMount = new QueryObserver(queryClient, options);
		const secondMount = new QueryObserver(queryClient, options);
		const unsubscribeFirst = firstMount.subscribe(() => {});
		const unsubscribeSecond = secondMount.subscribe(() => {});

		try {
			await waitFor(() => firstMount.getCurrentResult().status === "success");
			const initial = firstMount.getCurrentResult();
			expect({
				refreshCalls: refreshCalls.length,
				status: initial.status,
				fetchStatus: initial.fetchStatus,
				isStale: initial.isStale,
				error:
					initial.error instanceof Error
						? initial.error.message
						: initial.error,
			}).toEqual({
				refreshCalls: 1,
				status: "success",
				fetchStatus: "idle",
				isStale: false,
				error: null,
			});
			await waitFor(() => refreshCalls.length === 1);
			expect(refreshCalls).toHaveLength(1);

			await queryClient.invalidateQueries({
				queryKey,
				refetchType: "none",
			});
			expect(refreshCalls).toHaveLength(1);

			focusManager.setFocused(false);
			focusManager.setFocused(true);

			await waitFor(() => refreshCalls.length === 2);
			expect(refreshCalls).toHaveLength(2);
		} finally {
			unsubscribeFirst();
			unsubscribeSecond();
			queryClient.clear();
			queryClient.unmount();
			focusManager.setFocused(true);
		}
	});
});
