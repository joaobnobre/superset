import type { HostAgentConfig } from "@superset/host-service/settings";
import type { QueryClient } from "@tanstack/react-query";
import { V2_AGENT_CONFIGS_QUERY_KEY } from "renderer/hooks/useV2AgentConfigs";
import {
	hostAgentCapabilityRefreshQueryKey,
	hostAgentCapabilitySnapshotQueryKey,
} from "./capabilityQueryKeys";

export type HostAgentQueryInvalidation = "config" | "config-and-capabilities";

export function envsEqual(
	left: Record<string, string>,
	right: Record<string, string>,
): boolean {
	const leftEntries = Object.entries(left);
	const rightEntries = Object.entries(right);
	if (leftEntries.length !== rightEntries.length) return false;
	return leftEntries.every(([key, value]) => right[key] === value);
}

export function isDiscoveryChangingAgentPatch(
	current: Pick<HostAgentConfig, "command" | "env">,
	patch: { command?: string; env?: Record<string, string> },
): boolean {
	if (patch.command !== undefined && patch.command !== current.command) {
		return true;
	}
	return patch.env !== undefined && !envsEqual(current.env, patch.env);
}

export function classifyHostAgentUpdateInvalidation(
	current: Pick<HostAgentConfig, "command" | "env">,
	patch: { command?: string; env?: Record<string, string> },
): HostAgentQueryInvalidation {
	return isDiscoveryChangingAgentPatch(current, patch)
		? "config-and-capabilities"
		: "config";
}

export function invalidateHostAgentQueries(
	queryClient: QueryClient,
	hostUrl: string,
	scope: HostAgentQueryInvalidation,
): void {
	void queryClient.invalidateQueries({
		queryKey: [...V2_AGENT_CONFIGS_QUERY_KEY, hostUrl],
	});
	if (scope !== "config-and-capabilities") return;
	void queryClient.invalidateQueries({
		queryKey: hostAgentCapabilitySnapshotQueryKey(hostUrl),
	});
	void queryClient.invalidateQueries({
		queryKey: hostAgentCapabilityRefreshQueryKey(hostUrl),
	});
}
