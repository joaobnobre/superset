import { randomUUID } from "node:crypto";
import type { HostDb } from "../db";
import {
	type AgentCapabilityConfig,
	type AgentCapabilityErrorKind,
	AgentCapabilityProbeAbortedError,
	type AgentCapabilitySnapshot,
	clearAgentCapabilityCacheNamespace,
	getCachedAgentCapability,
	inspectAgentCapability,
} from "./agent-capabilities";
import {
	type AgentCapabilityInventory,
	type AgentHealthStatus,
	CAPABILITY_SNAPSHOT_DISPLAY_MAX_AGE_MS,
	CapabilityInventoryValidationError,
	displayableCapabilityInventory,
	encodeCapabilityInventory,
	listCapabilitySnapshots,
	type PersistedAgentCapabilitySnapshot,
	SANITIZED_CAPABILITY_MESSAGES,
	writeCapabilitySnapshotIfCurrentRevision,
} from "./capability-snapshot-repository";

export const CAPABILITY_PICKER_FRESHNESS_MS = 5 * 60 * 1_000;
export const CAPABILITY_LAUNCH_FRESHNESS_MS = 30_000;
export const CAPABILITY_REFRESH_CONCURRENCY = 4;
export const CAPABILITY_RETRY_BASE_DELAY_MS = 30_000;
export const CAPABILITY_RETRY_MAX_DELAY_MS = 5 * 60_000;

export interface RevisionedAgentCapabilityConfig extends AgentCapabilityConfig {
	configRevision: number;
}

export class ObsoleteCapabilityRefreshError extends Error {
	constructor(agentId: string) {
		super(`Capability refresh became obsolete for agent ${agentId}`);
		this.name = "ObsoleteCapabilityRefreshError";
	}
}

export interface AgentHealthObservation {
	status: AgentHealthStatus;
	installed: boolean | null;
	auth: "authenticated" | "unauthenticated" | "unknown";
	checkedAt: string;
	errorKind: AgentCapabilityErrorKind | null;
	message: string | null;
}

export interface AgentCapabilityView {
	agentId: string;
	presetId: string;
	inventory: AgentCapabilityInventory | null;
	inventoryOrigin: "live" | "persisted" | "none";
	health: AgentHealthObservation;
	healthOrigin: "live" | "persisted" | "none";
	refreshStatus: "idle" | "refreshing" | "backoff";
}

type CapabilityProbe = (
	config: AgentCapabilityConfig,
	options: { force?: boolean; now?: number; signal?: AbortSignal },
) => Promise<AgentCapabilitySnapshot>;

interface CapabilityRefreshState {
	abortController: AbortController;
	disposed: boolean;
	cacheNamespace: string;
	refreshInFlight: Map<string, Promise<AgentCapabilityView>>;
	backoffByKey: Map<string, { failures: number; nextRetryAt: number }>;
	launchLeases: Map<
		string,
		{ expiresAt: number; snapshot: AgentCapabilitySnapshot }
	>;
}

function createCapabilityRefreshState(): CapabilityRefreshState {
	return {
		abortController: new AbortController(),
		disposed: false,
		cacheNamespace: randomUUID(),
		refreshInFlight: new Map(),
		backoffByKey: new Map(),
		launchLeases: new Map(),
	};
}

let defaultRefreshState = createCapabilityRefreshState();

function refreshKey(config: RevisionedAgentCapabilityConfig): string {
	return `${config.id}:${config.configRevision}`;
}

function isTransientFailure(view: AgentCapabilityView): boolean {
	return (
		view.health.errorKind === "timeout" ||
		view.health.errorKind === "process_failure" ||
		view.health.errorKind === "parse_failure"
	);
}

function isTransientErrorKind(
	errorKind: AgentCapabilityErrorKind | null,
): boolean {
	return (
		errorKind === "timeout" ||
		errorKind === "process_failure" ||
		errorKind === "parse_failure"
	);
}

function recordBackoff(
	state: CapabilityRefreshState,
	key: string,
	view: AgentCapabilityView,
	now: number,
): void {
	if (!isTransientFailure(view)) {
		state.backoffByKey.delete(key);
		return;
	}
	const failures = (state.backoffByKey.get(key)?.failures ?? 0) + 1;
	const delay = Math.min(
		CAPABILITY_RETRY_BASE_DELAY_MS * 2 ** (failures - 1),
		CAPABILITY_RETRY_MAX_DELAY_MS,
	);
	state.backoffByKey.set(key, { failures, nextRetryAt: now + delay });
}

function inventorySourceToSnapshotSource(
	source: AgentCapabilityInventory["modelSource"],
): AgentCapabilitySnapshot["modelSource"] {
	return source === "curated" ? "fallback" : "runtime";
}

function sameSemanticInventory(
	left: AgentCapabilityInventory | null,
	right: AgentCapabilityInventory | null,
): boolean {
	if (left === right) return true;
	if (left === null || right === null) return false;
	return (
		left.schemaVersion === right.schemaVersion &&
		left.agentId === right.agentId &&
		left.presetId === right.presetId &&
		left.configRevision === right.configRevision &&
		left.detectedVersion === right.detectedVersion &&
		left.modelSource === right.modelSource &&
		JSON.stringify(left.models) === JSON.stringify(right.models)
	);
}

function isSuccessfulNonErrorHealth(next: {
	status: AgentHealthObservation["status"];
	errorKind: AgentHealthObservation["errorKind"];
}): boolean {
	return next.status === "ready" && next.errorKind === null;
}

function shouldPersistCapabilitySnapshot(
	previous: PersistedAgentCapabilitySnapshot | undefined,
	next: {
		inventory: AgentCapabilityInventory | null;
		status: AgentHealthObservation["status"];
		installed: boolean | null;
		auth: AgentHealthObservation["auth"];
		errorKind: AgentHealthObservation["errorKind"];
		message: string | null;
		resolverSource: PersistedAgentCapabilitySnapshot["resolverSource"];
	},
	now: number,
): boolean {
	if (!previous) return true;
	const materialChange =
		!sameSemanticInventory(previous.inventory, next.inventory) ||
		previous.status !== next.status ||
		previous.installed !== next.installed ||
		previous.auth !== next.auth ||
		previous.errorKind !== next.errorKind ||
		previous.message !== next.message ||
		previous.resolverSource !== next.resolverSource;
	if (materialChange) return true;
	if (!isSuccessfulNonErrorHealth(next)) return true;
	return now - previous.statusCheckedAt >= CAPABILITY_PICKER_FRESHNESS_MS;
}

function inventoryOrigin(
	liveInventory: AgentCapabilityInventory | null,
	mergedInventory: AgentCapabilityInventory | null,
): AgentCapabilityView["inventoryOrigin"] {
	if (liveInventory !== null) return "live";
	if (mergedInventory !== null) return "persisted";
	return "none";
}

export function persistedCapabilityToView(
	snapshot: PersistedAgentCapabilitySnapshot,
	refreshStatus: AgentCapabilityView["refreshStatus"] = "idle",
	now = Date.now(),
): AgentCapabilityView {
	const inventory = displayableCapabilityInventory(snapshot.inventory, now);
	return {
		agentId: snapshot.agentId,
		presetId: snapshot.presetId,
		inventory,
		inventoryOrigin: inventory ? "persisted" : "none",
		health: {
			status: snapshot.status,
			installed: snapshot.installed,
			auth: snapshot.auth,
			checkedAt: new Date(snapshot.statusCheckedAt).toISOString(),
			errorKind: snapshot.errorKind,
			message: snapshot.message,
		},
		healthOrigin: "persisted",
		refreshStatus,
	};
}

function viewToLaunchSnapshot(
	view: AgentCapabilityView,
): AgentCapabilitySnapshot {
	return {
		agentId: view.agentId,
		presetId: view.presetId,
		status:
			view.health.status === "unknown" ? "unavailable" : view.health.status,
		installed: view.health.installed ?? false,
		auth: view.health.auth,
		version: view.inventory?.detectedVersion ?? null,
		modelSource: view.inventory
			? inventorySourceToSnapshotSource(view.inventory.modelSource)
			: "none",
		models: view.inventory?.models ?? [],
		message: view.health.message,
		checkedAt: view.health.checkedAt,
		errorKind: view.health.errorKind,
		inventoryCheckedAt: view.inventory?.inventoryCheckedAt ?? null,
		inventoryOrigin: view.inventoryOrigin,
		healthOrigin:
			view.healthOrigin === "none" ? "persisted" : view.healthOrigin,
		refreshStatus: view.refreshStatus,
	};
}

function sanitizedDiagnosticMessage(
	snapshot: Pick<AgentCapabilitySnapshot, "auth" | "errorKind">,
): string | null {
	if (snapshot.auth === "unauthenticated") {
		return SANITIZED_CAPABILITY_MESSAGES.authenticationRequired;
	}
	switch (snapshot.errorKind) {
		case "missing_executable":
			return SANITIZED_CAPABILITY_MESSAGES.missingExecutable;
		case "timeout":
			return SANITIZED_CAPABILITY_MESSAGES.timeout;
		case "process_failure":
			return SANITIZED_CAPABILITY_MESSAGES.processFailure;
		case "parse_failure":
			return SANITIZED_CAPABILITY_MESSAGES.parseFailure;
		default:
			return null;
	}
}

function isolatedProcessFailureView(
	config: RevisionedAgentCapabilityConfig,
	previous: PersistedAgentCapabilitySnapshot | undefined,
	now: number,
): AgentCapabilityView {
	const checkedAt = new Date(now).toISOString();
	if (!previous) {
		return {
			agentId: config.id,
			presetId: config.presetId,
			inventory: null,
			inventoryOrigin: "none",
			health: {
				status: "unavailable",
				installed: null,
				auth: "unknown",
				checkedAt,
				errorKind: "process_failure",
				message: SANITIZED_CAPABILITY_MESSAGES.processFailure,
			},
			healthOrigin: "live",
			refreshStatus: "idle",
		};
	}
	return {
		...persistedCapabilityToView(previous, "idle", now),
		health: {
			status: "unavailable",
			installed: previous.installed,
			auth: "unknown",
			checkedAt,
			errorKind: "process_failure",
			message: SANITIZED_CAPABILITY_MESSAGES.processFailure,
		},
		healthOrigin: "live",
		refreshStatus: "idle",
	};
}

export function readPersistedCapabilitySnapshots(
	db: HostDb,
	now = Date.now(),
): AgentCapabilityView[] {
	return listCapabilitySnapshots(db, {
		now,
		maxDisplayAgeMs: CAPABILITY_SNAPSHOT_DISPLAY_MAX_AGE_MS,
	}).map((snapshot) => persistedCapabilityToView(snapshot, "idle", now));
}

function inventoryFromLiveSnapshot(
	config: RevisionedAgentCapabilityConfig,
	live: AgentCapabilitySnapshot,
): AgentCapabilityInventory | null {
	if (live.modelSource === "none") return null;
	return {
		schemaVersion: 1,
		agentId: config.id,
		presetId: config.presetId,
		configRevision: config.configRevision,
		detectedVersion: live.version,
		modelSource: live.modelSource === "fallback" ? "curated" : "runtime",
		models: live.models,
		inventoryCheckedAt: live.checkedAt,
	};
}

async function refreshCapabilityUncoalesced(
	db: HostDb,
	config: RevisionedAgentCapabilityConfig,
	previous: PersistedAgentCapabilitySnapshot | undefined,
	now: number,
	probe: CapabilityProbe,
	cacheNamespace: string,
	signal: AbortSignal,
): Promise<AgentCapabilityView> {
	let live: AgentCapabilitySnapshot;
	try {
		live = await probe(
			{ ...config, cacheNamespace },
			{ force: true, now, signal },
		);
	} catch (error) {
		if (signal.aborted || error instanceof AgentCapabilityProbeAbortedError) {
			throw new AgentCapabilityProbeAbortedError();
		}
		const errorKind: AgentCapabilityErrorKind =
			error instanceof CapabilityInventoryValidationError
				? "parse_failure"
				: "process_failure";
		live = {
			agentId: config.id,
			presetId: config.presetId,
			status: "unavailable",
			installed: previous?.installed ?? true,
			auth: "unknown",
			version: null,
			modelSource: "none",
			models: [],
			message: null,
			checkedAt: new Date(now).toISOString(),
			errorKind,
		};
	}

	if (signal.aborted) throw new AgentCapabilityProbeAbortedError();

	let liveInventory = inventoryFromLiveSnapshot(config, live);
	if (liveInventory !== null) {
		try {
			encodeCapabilityInventory(liveInventory);
		} catch {
			liveInventory = null;
			live = {
				...live,
				status: "unavailable",
				auth: "unknown",
				modelSource: "none",
				models: [],
				errorKind: "parse_failure",
				message: null,
			};
		}
	}

	const inventory =
		liveInventory ??
		(live.installed === false ? null : (previous?.inventory ?? null));
	const inventoryCheckedAt = inventory
		? Date.parse(inventory.inventoryCheckedAt)
		: null;
	const message = sanitizedDiagnosticMessage(live);
	const persist = shouldPersistCapabilitySnapshot(
		previous,
		{
			inventory,
			status: live.status,
			installed: live.installed,
			auth: live.auth,
			errorKind: live.errorKind ?? null,
			message,
			resolverSource: live.resolverSource ?? null,
		},
		now,
	);
	const written = writeCapabilitySnapshotIfCurrentRevision(
		db,
		{
			agentId: config.id,
			presetId: config.presetId,
			configRevision: config.configRevision,
			inventory,
			status: live.status,
			installed: live.installed,
			auth: live.auth,
			inventoryCheckedAt,
			statusCheckedAt: Date.parse(live.checkedAt),
			writtenAt: Date.parse(live.checkedAt),
			errorKind: live.errorKind ?? null,
			message,
			resolverSource: live.resolverSource ?? null,
		},
		{ persist },
	);
	if (!written) throw new ObsoleteCapabilityRefreshError(config.id);
	const displayInventory = displayableCapabilityInventory(inventory, now);
	return {
		agentId: config.id,
		presetId: config.presetId,
		inventory: displayInventory,
		inventoryOrigin: inventoryOrigin(liveInventory, displayInventory),
		health: {
			status: live.status,
			installed: live.installed,
			auth: live.auth,
			checkedAt: live.checkedAt,
			errorKind: live.errorKind ?? null,
			message,
		},
		healthOrigin: "live",
		refreshStatus: "idle",
	};
}

function refreshAgentCapabilityWithState(
	db: HostDb,
	config: RevisionedAgentCapabilityConfig,
	state: CapabilityRefreshState,
	options: {
		force?: boolean;
		now?: number;
		probe?: CapabilityProbe;
	} = {},
): Promise<AgentCapabilityView> {
	if (state.disposed) {
		return Promise.reject(new AgentCapabilityProbeAbortedError());
	}
	const now = options.now ?? Date.now();
	const previous = listCapabilitySnapshots(db, {
		now,
		agentId: config.id,
		includeHiddenInventory: true,
	})[0];
	const key = refreshKey(config);
	const backoff = state.backoffByKey.get(key);
	if (!options.force && previous && backoff && backoff.nextRetryAt > now) {
		return Promise.resolve(persistedCapabilityToView(previous, "backoff", now));
	}
	if (
		!options.force &&
		previous &&
		!isTransientErrorKind(previous.errorKind) &&
		now - previous.statusCheckedAt < CAPABILITY_PICKER_FRESHNESS_MS
	) {
		return Promise.resolve(persistedCapabilityToView(previous, "idle", now));
	}

	const existing = state.refreshInFlight.get(key);
	if (existing) return existing;
	const refresh = refreshCapabilityUncoalesced(
		db,
		config,
		previous,
		now,
		options.probe ?? inspectAgentCapability,
		state.cacheNamespace,
		state.abortController.signal,
	)
		.then((view) => {
			recordBackoff(state, key, view, now);
			state.launchLeases.set(key, {
				expiresAt: now + CAPABILITY_LAUNCH_FRESHNESS_MS,
				snapshot: viewToLaunchSnapshot(view),
			});
			return view;
		})
		.finally(() => {
			if (state.refreshInFlight.get(key) === refresh) {
				state.refreshInFlight.delete(key);
			}
		});
	state.refreshInFlight.set(key, refresh);
	return refresh;
}

export function refreshAgentCapability(
	db: HostDb,
	config: RevisionedAgentCapabilityConfig,
	options: {
		force?: boolean;
		now?: number;
		probe?: CapabilityProbe;
	} = {},
): Promise<AgentCapabilityView> {
	return refreshAgentCapabilityWithState(
		db,
		config,
		defaultRefreshState,
		options,
	);
}

/** Return a recent live result or probe only the selected launch agent. */
function ensureFreshAgentCapabilityWithState(
	db: HostDb,
	config: RevisionedAgentCapabilityConfig,
	state: CapabilityRefreshState,
	options: { now?: number; probe?: CapabilityProbe } = {},
): Promise<AgentCapabilitySnapshot> {
	if (state.disposed) {
		return Promise.reject(new AgentCapabilityProbeAbortedError());
	}
	const now = options.now ?? Date.now();
	const key = refreshKey(config);
	const lease = state.launchLeases.get(key);
	if (lease) {
		if (lease.expiresAt > now) return Promise.resolve(lease.snapshot);
		state.launchLeases.delete(key);
	}

	const cached = getCachedAgentCapability(
		{ ...config, cacheNamespace: state.cacheNamespace },
		now,
	);
	if (cached) return Promise.resolve(cached);

	return refreshAgentCapabilityWithState(db, config, state, {
		force: true,
		now,
		probe: options.probe,
	}).then(viewToLaunchSnapshot);
}

export function ensureFreshAgentCapability(
	db: HostDb,
	config: RevisionedAgentCapabilityConfig,
	options: { now?: number; probe?: CapabilityProbe } = {},
): Promise<AgentCapabilitySnapshot> {
	return ensureFreshAgentCapabilityWithState(
		db,
		config,
		defaultRefreshState,
		options,
	);
}

async function refreshAgentCapabilitiesWithState(
	db: HostDb,
	configs: RevisionedAgentCapabilityConfig[],
	state: CapabilityRefreshState,
	options: {
		force?: boolean;
		now?: number;
		concurrency?: number;
		probe?: CapabilityProbe;
	} = {},
): Promise<AgentCapabilityView[]> {
	const results = new Array<AgentCapabilityView>(configs.length);
	let nextIndex = 0;
	const concurrency = Math.max(
		1,
		Math.min(
			options.concurrency ?? CAPABILITY_REFRESH_CONCURRENCY,
			configs.length,
		),
	);
	async function worker(): Promise<void> {
		while (nextIndex < configs.length) {
			const resultIndex = nextIndex;
			nextIndex += 1;
			const config = configs[resultIndex];
			if (!config) continue;
			try {
				results[resultIndex] = await refreshAgentCapabilityWithState(
					db,
					config,
					state,
					{
						force: options.force,
						now: options.now,
						probe: options.probe,
					},
				);
			} catch (error) {
				if (
					state.disposed ||
					state.abortController.signal.aborted ||
					error instanceof AgentCapabilityProbeAbortedError ||
					error instanceof ObsoleteCapabilityRefreshError
				) {
					throw error;
				}
				const previous = listCapabilitySnapshots(db, {
					now: options.now,
					agentId: config.id,
					includeHiddenInventory: true,
				})[0];
				results[resultIndex] = isolatedProcessFailureView(
					config,
					previous,
					options.now ?? Date.now(),
				);
			}
		}
	}
	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	return results;
}

export function refreshAgentCapabilities(
	db: HostDb,
	configs: RevisionedAgentCapabilityConfig[],
	options: {
		force?: boolean;
		now?: number;
		concurrency?: number;
		probe?: CapabilityProbe;
	} = {},
): Promise<AgentCapabilityView[]> {
	return refreshAgentCapabilitiesWithState(
		db,
		configs,
		defaultRefreshState,
		options,
	);
}

export class CapabilityRefreshService {
	readonly #state = createCapabilityRefreshState();

	constructor(readonly db: HostDb) {}

	readPersisted(now = Date.now()): AgentCapabilityView[] {
		return readPersistedCapabilitySnapshots(this.db, now);
	}

	refreshCapability(
		config: RevisionedAgentCapabilityConfig,
		options: { force?: boolean; now?: number; probe?: CapabilityProbe } = {},
	): Promise<AgentCapabilityView> {
		return refreshAgentCapabilityWithState(
			this.db,
			config,
			this.#state,
			options,
		);
	}

	refreshCapabilities(
		configs: RevisionedAgentCapabilityConfig[],
		options: {
			force?: boolean;
			now?: number;
			concurrency?: number;
			probe?: CapabilityProbe;
		} = {},
	): Promise<AgentCapabilityView[]> {
		return refreshAgentCapabilitiesWithState(
			this.db,
			configs,
			this.#state,
			options,
		);
	}

	ensureFreshCapability(
		config: RevisionedAgentCapabilityConfig,
		options: { now?: number; probe?: CapabilityProbe } = {},
	): Promise<AgentCapabilitySnapshot> {
		return ensureFreshAgentCapabilityWithState(
			this.db,
			config,
			this.#state,
			options,
		);
	}

	async dispose(): Promise<void> {
		if (this.#state.disposed) return;
		this.#state.disposed = true;
		this.#state.abortController.abort();
		await Promise.allSettled(this.#state.refreshInFlight.values());
		clearAgentCapabilityCacheNamespace(this.#state.cacheNamespace);
		this.#state.refreshInFlight.clear();
		this.#state.backoffByKey.clear();
		this.#state.launchLeases.clear();
	}
}

export function clearCapabilityRefreshState(): void {
	defaultRefreshState.abortController.abort();
	defaultRefreshState = createCapabilityRefreshState();
}
