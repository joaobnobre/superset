import {
	deduplicateBranchName,
	sanitizeBranchNameWithMaxLength,
	slugifyForBranch,
} from "@superset/shared/workspace-launch";
import type { relayMutation } from "./relay-client";

export type AutomationAgentRunResult = {
	kind: "terminal";
	sessionId: string;
	label: string;
};

export type HostAgentLaunchResult =
	| { ok: true; kind: "terminal"; sessionId: string; label: string }
	| { ok: false; error: string };

export type FreshWorkspaceMutate = typeof relayMutation;

export function automationAgentLaunch(automation: {
	agent: string;
	prompt: string;
}): { agent: string; prompt: string } {
	return { agent: automation.agent, prompt: automation.prompt };
}

export function pickLaunchedAutomationAgent(
	agents: HostAgentLaunchResult[] | undefined,
): AutomationAgentRunResult | null {
	if (!agents || agents.length === 0) return null;
	const failed = agents.find((entry) => !entry.ok);
	if (failed && !failed.ok) {
		throw new Error(failed.error);
	}
	const launched = agents.find((entry) => entry.ok);
	if (!launched || !launched.ok) return null;
	return {
		kind: launched.kind,
		sessionId: launched.sessionId,
		label: launched.label,
	};
}

export async function createFreshAutomationWorkspace(args: {
	relayUrl: string;
	hostId: string;
	jwt: string;
	projectId: string | null;
	automation: { name: string; agent: string; prompt: string };
	mutate: FreshWorkspaceMutate;
}): Promise<{
	workspaceId: string;
	launchedAgent: AutomationAgentRunResult | null;
}> {
	const agents = [automationAgentLaunch(args.automation)];

	if (args.projectId === null) {
		const result = await args.mutate<
			{ name: string; agents: Array<{ agent: string; prompt: string }> },
			{
				workspace: { id: string };
				agents?: HostAgentLaunchResult[];
			}
		>(
			{
				relayUrl: args.relayUrl,
				hostId: args.hostId,
				jwt: args.jwt,
				timeoutMs: 90_000,
			},
			"workspaces.createSession",
			{ name: args.automation.name.slice(0, 100), agents },
		);
		return {
			workspaceId: result.workspace.id,
			launchedAgent: pickLaunchedAutomationAgent(result.agents),
		};
	}

	const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
	const baseSlug = slugifyForBranch(args.automation.name, 30);
	const candidateBranch = sanitizeBranchNameWithMaxLength(
		baseSlug ? `${baseSlug}-${timestamp}` : `automation-${timestamp}`,
		60,
	);
	const branchName = deduplicateBranchName(candidateBranch, []);
	const workspaceName = args.automation.name.slice(0, 100);

	const result = await args.mutate<
		{
			projectId: string;
			name: string;
			branch: string;
			agents: Array<{ agent: string; prompt: string }>;
		},
		{
			workspace: { id: string };
			agents?: HostAgentLaunchResult[];
		}
	>(
		{
			relayUrl: args.relayUrl,
			hostId: args.hostId,
			jwt: args.jwt,
			timeoutMs: 90_000,
		},
		"workspaces.create",
		{
			projectId: args.projectId,
			name: workspaceName,
			branch: branchName,
			agents,
		},
	);

	return {
		workspaceId: result.workspace.id,
		launchedAgent: pickLaunchedAutomationAgent(result.agents),
	};
}
