import {
	isAgentChoiceEnabled,
	isAgentChoiceVisible,
} from "renderer/hooks/useV2AgentChoices";

export type LinkedPresetAvailability =
	| "unlinked"
	| "hidden"
	| "disabled"
	| "enabled";

function findLinkedAgentId(
	agents: ReadonlyArray<{ id: string; presetId?: string }> | undefined,
	agentId: string,
): string {
	const linked =
		agents?.find((agent) => agent.id === agentId) ??
		agents?.find((agent) => agent.presetId === agentId);
	return linked?.id ?? agentId;
}

export function getLinkedPresetAvailability(
	preset: { agentId?: string },
	capabilitiesByAgentId: ReadonlyMap<
		string,
		{
			health: {
				installed: boolean | null;
				auth: "authenticated" | "unauthenticated" | "unknown";
				status: "ready" | "unavailable" | "authentication_required" | "unknown";
			};
		}
	>,
	agents?: ReadonlyArray<{ id: string; presetId?: string }>,
): LinkedPresetAvailability {
	if (!preset.agentId) return "unlinked";
	const capability = capabilitiesByAgentId.get(
		findLinkedAgentId(agents, preset.agentId),
	);
	if (!isAgentChoiceVisible(capability)) return "hidden";
	if (!isAgentChoiceEnabled(capability)) return "disabled";
	return "enabled";
}
