/**
 * Cross-cutting error shapes surfaced via the tRPC error formatter.
 * Lives here (not in a router) to avoid circular imports with `trpc/index.ts`.
 */
import { z } from "zod";

export interface TeardownFailureCause {
	kind: "TEARDOWN_FAILED";
	exitCode: number | null;
	/** Signal number (Unix). null when the process exited normally. */
	signal: number | null;
	timedOut: boolean;
	outputTail: string;
}

export function isTeardownFailureCause(
	value: unknown,
): value is TeardownFailureCause {
	return (
		!!value &&
		typeof value === "object" &&
		"kind" in value &&
		(value as { kind: unknown }).kind === "TEARDOWN_FAILED"
	);
}

/**
 * Thrown by host-service procedures that require the project to already
 * be set up on this host.
 */
export interface ProjectNotSetupCause {
	kind: "PROJECT_NOT_SETUP";
	projectId: string;
}

export function isProjectNotSetupCause(
	value: unknown,
): value is ProjectNotSetupCause {
	return (
		!!value &&
		typeof value === "object" &&
		"kind" in value &&
		(value as { kind: unknown }).kind === "PROJECT_NOT_SETUP"
	);
}

/**
 * Thrown by `workspaceCleanup.destroy` when another destroy for the same
 * workspace is already in flight. Distinct from a dirty-worktree CONFLICT
 * because the renderer must NOT silently retry with `force: true` — the
 * second caller should surface as a toast and let the first run finish.
 */
export interface DeleteInProgressCause {
	kind: "DELETE_IN_PROGRESS";
}

export function isDeleteInProgressCause(
	value: unknown,
): value is DeleteInProgressCause {
	return (
		!!value &&
		typeof value === "object" &&
		"kind" in value &&
		(value as { kind: unknown }).kind === "DELETE_IN_PROGRESS"
	);
}

export const AGENT_LAUNCH_CAPABILITY_ERROR_KINDS = [
	"authentication_required",
	"config_changed",
	"expired_lease",
	"missing_executable",
	"retired_model",
	"selection_mismatch",
	"unavailable",
	"unsupported_trait",
] as const;

export type AgentLaunchCapabilityErrorKind =
	(typeof AGENT_LAUNCH_CAPABILITY_ERROR_KINDS)[number];

export interface AgentLaunchCapabilityWire {
	kind: AgentLaunchCapabilityErrorKind;
}

const agentLaunchCapabilityWireSchema = z.object({
	kind: z.enum(AGENT_LAUNCH_CAPABILITY_ERROR_KINDS),
});

/**
 * Detects a launch-capability cause on a TRPCError. Matches the stable
 * `kind` rather than `instanceof` so wrapped/serialized causes still work.
 */
export function isAgentLaunchCapabilityCause(
	value: unknown,
): value is { kind: AgentLaunchCapabilityErrorKind } {
	return agentLaunchCapabilityWireSchema.safeParse(value).success;
}
