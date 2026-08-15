import type { AppRouter } from "@superset/host-service";
import { useQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useMemo } from "react";
import type { AgentSelectAgent } from "renderer/components/AgentSelect";
import { useV2AgentConfigs } from "renderer/hooks/useV2AgentConfigs";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import {
	isAgentChoiceEnabled,
	isAgentChoiceVisible,
} from "./agentChoiceAvailability";
import {
	hostAgentCapabilityRefreshQueryKey,
	hostAgentCapabilitySnapshotQueryKey,
} from "./capabilityQueryKeys";
import {
	mergeCapabilityViews,
	resolveAgentChoicesFetched,
} from "./mergeCapabilityViews";

type HostServiceRouterOutputs = inferRouterOutputs<AppRouter>;

export type AgentChoiceCapability =
	HostServiceRouterOutputs["settings"]["agentConfigs"]["listCapabilitySnapshots"][number];

interface UseV2AgentChoicesResult {
	agents: AgentSelectAgent[];
	capabilitiesByAgentId: ReadonlyMap<string, AgentChoiceCapability>;
	isFetched: boolean;
}

interface UseV2AgentChoicesOptions {
	refresh?: boolean;
}

const CAPABILITY_PICKER_FRESHNESS_MS = 5 * 60 * 1_000;

export function groupAgentsByAvailability(
	agents: readonly AgentSelectAgent[],
): { ready: AgentSelectAgent[]; unavailable: AgentSelectAgent[] } {
	return {
		ready: agents.filter((agent) => !agent.disabled),
		unavailable: agents.filter((agent) => agent.disabled),
	};
}

export function useV2AgentChoices(
	hostUrl: string | null,
	options: UseV2AgentChoicesOptions = {},
): UseV2AgentChoicesResult {
	const query = useV2AgentConfigs(hostUrl);
	const refreshEnabled = options.refresh !== false;
	const snapshotsQuery = useQuery({
		queryKey: hostAgentCapabilitySnapshotQueryKey(hostUrl),
		enabled: !!hostUrl,
		queryFn: () => {
			if (!hostUrl) return [] satisfies AgentChoiceCapability[];
			return getHostServiceClientByUrl(
				hostUrl,
			).settings.agentConfigs.listCapabilitySnapshots.query();
		},
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
	const refreshQuery = useQuery({
		queryKey: hostAgentCapabilityRefreshQueryKey(hostUrl),
		enabled: !!hostUrl && refreshEnabled,
		queryFn: () => {
			if (!hostUrl) return [] satisfies AgentChoiceCapability[];
			return getHostServiceClientByUrl(
				hostUrl,
			).settings.agentConfigs.refreshCapabilities.mutate({});
		},
		staleTime: CAPABILITY_PICKER_FRESHNESS_MS,
		refetchOnWindowFocus: true,
	});
	const capabilitiesByAgentId = useMemo(
		() =>
			new Map(
				mergeCapabilityViews(snapshotsQuery.data ?? [], refreshQuery.data).map(
					(capability) => [capability.agentId, capability],
				),
			),
		[snapshotsQuery.data, refreshQuery.data],
	);
	const isFetched = resolveAgentChoicesFetched({
		configsFetched: query.isFetched,
		snapshotsFetched: snapshotsQuery.isFetched,
		snapshotCount: snapshotsQuery.data?.length ?? 0,
		refreshEnabled,
		refreshSettled: refreshQuery.isFetched,
	});
	const agents = useMemo<AgentSelectAgent[]>(() => {
		if (!query.data || !isFetched) return [];
		const terminalAgents: AgentSelectAgent[] = query.data
			.filter((config) =>
				isAgentChoiceVisible(capabilitiesByAgentId.get(config.id)),
			)
			.map((config) => ({
				id: config.id,
				label: config.label,
				disabled: !isAgentChoiceEnabled(capabilitiesByAgentId.get(config.id)),
				// Prefer the user's icon override (built-in key or uploaded data
				// URI); fall back to the preset-implied icon.
				iconId: config.iconId ?? config.presetId,
				presetId: config.presetId,
			}));
		const { ready, unavailable } = groupAgentsByAvailability(terminalAgents);
		return [...ready, ...unavailable];
	}, [capabilitiesByAgentId, isFetched, query.data]);

	return {
		agents,
		capabilitiesByAgentId,
		isFetched,
	};
}
