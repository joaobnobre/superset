import type { AppRouter } from "@superset/host-service";
import type { QueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { hostAgentCapabilitySnapshotQueryKey } from "./capabilityQueryKeys";

type HostServiceClientError = TRPCClientError<AppRouter>;
type HostServiceErrorData = NonNullable<HostServiceClientError["data"]>;

export type AgentLaunchCapabilityError = NonNullable<
	HostServiceErrorData["agentLaunchCapability"]
>;

function isHostServiceClientError(
	error: unknown,
): error is HostServiceClientError {
	return error instanceof TRPCClientError;
}

export function getAgentLaunchCapabilityError(
	error: unknown,
): AgentLaunchCapabilityError | null {
	if (!isHostServiceClientError(error)) return null;
	return error.data?.agentLaunchCapability ?? null;
}

export function invalidateCapabilitiesOnLaunchError(
	queryClient: QueryClient,
	hostUrl: string | null,
	error: unknown,
): boolean {
	if (!hostUrl || !getAgentLaunchCapabilityError(error)) return false;
	void queryClient.invalidateQueries({
		queryKey: hostAgentCapabilitySnapshotQueryKey(hostUrl),
	});
	return true;
}
