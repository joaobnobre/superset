import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { AgentSelectAgent } from "renderer/components/AgentSelect";
import { useV2AgentConfigs } from "renderer/hooks/useV2AgentConfigs";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";

export interface AgentChoiceCapability {
	agentId: string;
	presetId: string;
	status: "ready" | "unavailable" | "authentication_required";
	installed: boolean;
	auth: "authenticated" | "unauthenticated" | "unknown";
	version: string | null;
	modelSource: "runtime" | "fallback" | "none";
	models: Array<{
		id: string;
		label: string;
		provider?: string;
		defaultEffortId?: string;
		efforts?: Array<{ id: string; label: string }>;
	}>;
	message: string | null;
}

interface UseV2AgentChoicesResult {
	agents: AgentSelectAgent[];
	capabilitiesByAgentId: ReadonlyMap<string, AgentChoiceCapability>;
	isFetched: boolean;
}

const SUPERSET_AGENT: AgentSelectAgent = {
	id: "superset",
	label: "Superset",
	iconId: "superset",
};

export function groupAgentsByAvailability(
	agents: readonly AgentSelectAgent[],
): { ready: AgentSelectAgent[]; unavailable: AgentSelectAgent[] } {
	return {
		ready: agents.filter((agent) => !agent.disabled),
		unavailable: agents.filter((agent) => agent.disabled),
	};
}

// Superset chat isn't in the host's `host_agent_configs` table. It is routed
// by id inside `runAgentInWorkspace`, between ready and unavailable agents.
export function useV2AgentChoices(
	hostUrl: string | null,
): UseV2AgentChoicesResult {
	const query = useV2AgentConfigs(hostUrl);
	const capabilitiesQuery = useQuery({
		queryKey: ["host-agent-capabilities", hostUrl] as const,
		enabled: !!hostUrl,
		queryFn: () => {
			if (!hostUrl) return [] as AgentChoiceCapability[];
			return getHostServiceClientByUrl(
				hostUrl,
			).settings.agentConfigs.capabilities.query();
		},
		staleTime: 30_000,
		refetchOnWindowFocus: "always",
	});
	const capabilitiesByAgentId = useMemo(
		() =>
			new Map(
				(capabilitiesQuery.data ?? []).map((capability) => [
					capability.agentId,
					capability,
				]),
			),
		[capabilitiesQuery.data],
	);
	const agents = useMemo<AgentSelectAgent[]>(() => {
		if (!query.data) return [];
		const terminalAgents: AgentSelectAgent[] = query.data
			.filter((config) => capabilitiesByAgentId.get(config.id)?.installed)
			.map((config) => ({
				id: config.id,
				label: config.label,
				disabled: capabilitiesByAgentId.get(config.id)?.status !== "ready",
				// Prefer the user's icon override (built-in key or uploaded data
				// URI); fall back to the preset-implied icon.
				iconId: config.iconId ?? config.presetId,
				presetId: config.presetId,
			}));
		const { ready, unavailable } = groupAgentsByAvailability(terminalAgents);
		return [...ready, SUPERSET_AGENT, ...unavailable];
	}, [capabilitiesByAgentId, query.data]);

	return {
		agents,
		capabilitiesByAgentId,
		isFetched: query.isFetched && capabilitiesQuery.isFetched,
	};
}
