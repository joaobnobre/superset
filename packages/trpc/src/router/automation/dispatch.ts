import { mintUserJwt } from "@superset/auth/server";
import { dbWs } from "@superset/db/client";
import {
	automationRuns,
	automations,
	type SelectAutomation,
	users,
	v2Hosts,
	v2UsersHosts,
} from "@superset/db/schema";
import { buildHostRoutingKey } from "@superset/shared/host-routing";
import { and, eq, sql } from "drizzle-orm";
import { fetchRelayPresence } from "../../lib/relay-presence";
import { createFreshAutomationWorkspace as createFreshAutomationWorkspaceOnHost } from "./dispatch-fresh-workspace";
import { RelayDispatchError, relayMutation } from "./relay-client";

type AgentRunResult = { kind: "terminal"; sessionId: string; label: string };

export type DispatchOutcome =
	| { status: "dispatched"; runId: string }
	| { status: "skipped_offline"; runId: string | null; error: string }
	| { status: "dispatch_failed"; runId: string | null; error: string }
	| { status: "conflict" };

/**
 * Only what dispatch actually reads. Deliberately excludes the schedule
 * columns, which live on the automation's trigger.
 */
export type DispatchableAutomation = Pick<
	SelectAutomation,
	| "id"
	| "name"
	| "organizationId"
	| "ownerUserId"
	| "agent"
	| "prompt"
	| "targetHostId"
	| "v2ProjectId"
	| "v2WorkspaceId"
>;

export interface DispatchOptions {
	automation: DispatchableAutomation;
	scheduledFor: Date;
	relayUrl: string;
}

/**
 * Run one automation: resolve host, (maybe) create a workspace, start the
 * agent session. Writes an automation_runs row regardless of outcome. Does
 * NOT touch automations.next_run_at — that advancement is the caller's
 * concern (the cron advances on every tick; runNow intentionally leaves
 * the regular cadence alone).
 */
export async function dispatchAutomation(
	opts: DispatchOptions,
): Promise<DispatchOutcome> {
	const { automation, scheduledFor, relayUrl } = opts;

	const candidates = await resolveCandidateHosts(automation);
	if (candidates.length === 0) {
		const error = "no host available";
		const inserted = await recordSkipped(automation, scheduledFor, null, error);
		return { status: "skipped_offline", runId: inserted?.id ?? null, error };
	}

	const host = await pickOnlineHost(automation, relayUrl, candidates);
	if (!host) {
		const error = "target host offline";
		const inserted = await recordSkipped(
			automation,
			scheduledFor,
			candidates[0]?.machineId ?? null,
			error,
		);
		return { status: "skipped_offline", runId: inserted?.id ?? null, error };
	}

	const [run] = await dbWs
		.insert(automationRuns)
		.values({
			automationId: automation.id,
			organizationId: automation.organizationId,
			title: automation.name,
			scheduledFor,
			hostId: host.machineId,
			status: "dispatching",
		})
		.onConflictDoNothing({
			target: [automationRuns.automationId, automationRuns.scheduledFor],
			where: sql`${automationRuns.scheduledFor} IS NOT NULL`,
		})
		.returning();

	if (!run) return { status: "conflict" };

	let workspaceId: string | null = null;
	try {
		const [owner] = await dbWs
			.select({ email: users.email })
			.from(users)
			.where(eq(users.id, automation.ownerUserId))
			.limit(1);

		const jwt = await mintUserJwt({
			userId: automation.ownerUserId,
			email: owner?.email,
			organizationIds: [automation.organizationId],
			scope: "automation-run",
			runId: run.id,
			ttlSeconds: 300,
		});

		const routingKey = buildHostRoutingKey(
			automation.organizationId,
			host.machineId,
		);

		const createFreshWorkspace = async () => {
			const created = await createFreshAutomationWorkspaceOnHost({
				relayUrl,
				hostId: routingKey,
				jwt,
				projectId: automation.v2ProjectId,
				automation,
				mutate: relayMutation,
			});
			return created;
		};

		const runAgent = (targetWorkspaceId: string) =>
			runAgentOnHost({
				relayUrl,
				hostId: routingKey,
				jwt,
				workspaceId: targetWorkspaceId,
				agent: automation.agent,
				prompt: automation.prompt,
			});

		let launchedAgent: AgentRunResult | null = null;
		if (automation.v2WorkspaceId) {
			workspaceId = automation.v2WorkspaceId;
		} else {
			const created = await createFreshWorkspace();
			workspaceId = created.workspaceId;
			launchedAgent = created.launchedAgent;
		}
		if (!workspaceId) {
			throw new Error("workspace id missing after create");
		}

		let result: AgentRunResult;
		try {
			result = launchedAgent ?? (await runAgent(workspaceId));
		} catch (err) {
			// Fall back only when the host says the pinned workspace is gone:
			// tRPC NOT_FOUND (404) naming the pinned id. Other NOT_FOUNDs
			// (agent config, attachments) rethrow.
			const stalePin = automation.v2WorkspaceId;
			const pinGone =
				stalePin !== null &&
				stalePin === workspaceId &&
				err instanceof RelayDispatchError &&
				err.status === 404 &&
				err.message.includes(stalePin);
			if (!pinGone) throw err;
			// Clear the pin (CAS so a concurrent repin is never erased) and use
			// a fresh workspace from here on.
			await dbWs
				.update(automations)
				.set({ v2WorkspaceId: null })
				.where(
					and(
						eq(automations.id, automation.id),
						eq(automations.v2WorkspaceId, stalePin),
					),
				);
			// Don't let the outer catch record the dead id if fresh-create throws.
			workspaceId = null;
			launchedAgent = null;
			const created = await createFreshWorkspace();
			workspaceId = created.workspaceId;
			result = created.launchedAgent ?? (await runAgent(workspaceId));
		}

		await dbWs
			.update(automationRuns)
			.set({
				status: "dispatched",
				sessionKind: result.kind,
				chatSessionId: null,
				terminalSessionId: result.sessionId,
				v2WorkspaceId: workspaceId,
				dispatchedAt: new Date(),
			})
			.where(eq(automationRuns.id, run.id));
	} catch (err) {
		const error = describeError(err, "dispatch");
		await dbWs
			.update(automationRuns)
			.set({
				status: "dispatch_failed",
				v2WorkspaceId: workspaceId,
				error,
			})
			.where(eq(automationRuns.id, run.id));
		return { status: "dispatch_failed", runId: run.id, error };
	}

	return { status: "dispatched", runId: run.id };
}

async function resolveCandidateHosts(
	automation: DispatchableAutomation,
): Promise<Array<typeof v2Hosts.$inferSelect>> {
	if (automation.targetHostId) {
		const [host] = await dbWs
			.select()
			.from(v2Hosts)
			.where(
				and(
					eq(v2Hosts.organizationId, automation.organizationId),
					eq(v2Hosts.machineId, automation.targetHostId),
				),
			)
			.limit(1);

		return host ? [host] : [];
	}

	return dbWs
		.select({
			organizationId: v2Hosts.organizationId,
			machineId: v2Hosts.machineId,
			name: v2Hosts.name,
			isOnline: v2Hosts.isOnline,
			wakeCommand: v2Hosts.wakeCommand,
			createdByUserId: v2Hosts.createdByUserId,
			createdAt: v2Hosts.createdAt,
			updatedAt: v2Hosts.updatedAt,
		})
		.from(v2Hosts)
		.innerJoin(
			v2UsersHosts,
			and(
				eq(v2UsersHosts.organizationId, v2Hosts.organizationId),
				eq(v2UsersHosts.hostId, v2Hosts.machineId),
			),
		)
		.where(
			and(
				eq(v2UsersHosts.userId, automation.ownerUserId),
				eq(v2Hosts.organizationId, automation.organizationId),
			),
		)
		.orderBy(v2Hosts.updatedAt);
}

/**
 * The relay's DOs are the presence authority; the DB flag only decides for
 * hosts still on the v1 relay (which keeps writing it). First online
 * candidate wins, preserving the updatedAt ordering.
 */
async function pickOnlineHost(
	automation: DispatchableAutomation,
	relayUrl: string,
	candidates: Array<typeof v2Hosts.$inferSelect>,
): Promise<typeof v2Hosts.$inferSelect | null> {
	const jwt = await mintUserJwt({
		userId: automation.ownerUserId,
		organizationIds: [automation.organizationId],
		scope: "automation-presence",
		ttlSeconds: 60,
	});
	const presence = await fetchRelayPresence(
		relayUrl,
		jwt,
		candidates.map((host) =>
			buildHostRoutingKey(host.organizationId, host.machineId),
		),
	);
	return (
		candidates.find((host) => {
			const info =
				presence?.[buildHostRoutingKey(host.organizationId, host.machineId)];
			return info ? info.online : host.isOnline;
		}) ?? null
	);
}

async function recordSkipped(
	automation: DispatchableAutomation,
	scheduledFor: Date,
	hostId: string | null,
	error: string,
): Promise<{ id: string } | undefined> {
	const [row] = await dbWs
		.insert(automationRuns)
		.values({
			automationId: automation.id,
			organizationId: automation.organizationId,
			title: automation.name,
			scheduledFor,
			hostId,
			status: "skipped_offline",
			error,
		})
		.onConflictDoNothing({
			target: [automationRuns.automationId, automationRuns.scheduledFor],
			where: sql`${automationRuns.scheduledFor} IS NOT NULL`,
		})
		.returning({ id: automationRuns.id });
	return row;
}

async function runAgentOnHost(args: {
	relayUrl: string;
	hostId: string;
	jwt: string;
	workspaceId: string;
	agent: string;
	prompt: string;
}): Promise<AgentRunResult> {
	return relayMutation<
		{
			workspaceId: string;
			agent: string;
			prompt: string;
		},
		AgentRunResult
	>(
		{ relayUrl: args.relayUrl, hostId: args.hostId, jwt: args.jwt },
		"agents.run",
		{
			workspaceId: args.workspaceId,
			agent: args.agent,
			prompt: args.prompt,
		},
	);
}

function describeError(err: unknown, context: string): string {
	if (err instanceof RelayDispatchError) return `${context}: ${err.message}`;
	if (err instanceof Error) return `${context}: ${err.message}`;
	return `${context}: unknown error`;
}
