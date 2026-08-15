# Agent capability snapshots and background refresh

## Goal

Make the workspace agent, model, and trait pickers render immediately from the
last known valid snapshot for the selected host, then refresh against that
host's installed CLIs in the background. Runtime discovery remains
authoritative. Persisted snapshots improve startup UX but never become permanent
model catalogs or an authorization bypass.

This plan builds on the initial `agent-capabilities` probe layer. It does not try
to make every provider use the same discovery protocol. Claude Code remains a
curated, version-gated catalog until its CLI exposes a reliable account-specific
model inventory. Superset chat remains application-owned and is not part of the
local CLI snapshot cache.

## Implementation status

- [x] Base the work on the fork's cleaned dynamic-capabilities branch.
- [x] Replace optional runtime reasoning efforts with explicit
  `unknown`/`unsupported`/`supported` semantics.
- [x] Use one reasoning resolver in picker and launch validation, including
  runtime-only options such as Pi `max`.
- [x] Add revision-safe SQLite persistence and strict snapshot decoding.
- [x] Split cached reads from stale-only refresh and remove closed-surface probes.
- [x] Render cache-first and centralize first-use/focus refresh with a 5-minute
  stale window per host.
- [x] Add short-lived launch freshness leases across every launch path.
- [x] Move refresh ownership into the app lifecycle with probe cancellation and
  safe disposal before SQLite closes.
- [x] Add typed timeout/process/parse diagnostics and demand-driven retry
  backoff without background timers.
- [x] Cover every launch path, including linked presets and fresh-workspace
  automation, with the same async capability preflight.
- [x] Resolve installed executables from explicit configuration and `PATH`
  without reading npm, Bun, pnpm, or other package-manager caches.
- [x] Validate the cache-first lifecycle in the real desktop app on Linux.

## Baseline and prerequisite ownership

The active feature branch contains the expanded runtime capability layer:

- a process-local cache with a 30-second TTL;
- runtime discovery for Codex, OpenCode, Cursor, Pi, Antigravity, Copilot, Grok,
  and Kimi where their installed tools expose usable metadata;
- provider-specific authentication and availability observations;
- curated fallback catalogs for providers without authoritative inventory;
- a blocking `settings.agentConfigs.capabilities` query;
- a renderer hook and picker surfaces that consume discovered models and traits.

The original baseline ambiguity was the optional `efforts` field, which could
not distinguish unavailable metadata from an authoritative report that a model
does not support reasoning. Slice 1 has replaced it with a tagged reasoning
contract before persistence is built on top of it.

## Product behavior

Opening any workspace-create or agent-selection surface follows
stale-while-revalidate semantics:

1. Read the most recent valid snapshot for this host without running a CLI.
2. Render usable cached choices immediately when the snapshot is within the
   display-age policy.
3. Mark cached health and inventory provenance internally and start one
   deduplicated background refresh only when the relevant agent data is stale.
4. Replace inventory atomically when a live authoritative probe succeeds.
5. Preserve the last good inventory during transient failures, while exposing
   the latest health/authentication observation separately.
6. Remove an agent immediately when a live probe confirms its executable is
   missing.
7. Disable an installed but unauthenticated agent and order it below ready
   agents.
8. Reconcile selected models and traits only after a successful authoritative
   refresh explicitly removes them.

The normal successful path does not show a loading skeleton when a usable
snapshot exists. Cached choices must not flicker, disappear, reset scroll, or
reset selection during revalidation. A subtle refresh indicator is optional.

Initial retention policy:

- snapshots up to 7 days old may render while revalidation runs;
- older snapshots are not rendered as choices;
- rows older than 30 days are deleted during bounded startup maintenance;
- a recent live missing-executable result clears persisted inventory immediately
  but retains the unavailable health observation and timestamp.

These durations are named constants and covered by clock-controlled tests.

## Demand-driven refresh policy

Do not probe every configured CLI merely because the host-service or desktop
starts. Startup reads SQLite and performs bounded retention cleanup only. It does
not spawn agent processes.

Refresh work is triggered by actual demand:

- opening a surface that needs agent choices refreshes only stale agents visible
  to that surface;
- window focus requests refresh only when those agents are stale;
- launch reuses a sufficiently recent live result and probes only the selected
  agent when launch freshness has expired;
- config changes invalidate only the affected agent and may refresh it when a
  relevant surface is active;
- explicit retry or future Health Center actions may force one affected agent.

Initial freshness windows:

- 30 seconds for the current in-memory live result; concurrent callers share the
  same promise for the full probe duration;
- 5 minutes before a picker demand considers live health stale;
- 30 seconds before account-dependent launch validation requires a new live
  result.

The persisted table stores one current row per agent and overwrites it. It is not
an observation history. Persist immediately when inventory, authentication, or
availability changes. An unchanged successful health check may update its
heartbeat at most once per picker freshness window, avoiding unnecessary SQLite
writes.

## Capability data contract

Do not overload absence. Every runtime-derived trait uses an explicit tagged
state:

```ts
type CapabilityTrait<TOption> =
	| { state: "unknown" }
	| { state: "unsupported" }
	| {
			state: "supported";
			options: TOption[];
			defaultId?: string;
	  };

interface AgentCapabilityModel {
	id: string;
	label: string;
	provider?: string;
	reasoning: CapabilityTrait<ModelOption>;
}
```

Reasoning is the first runtime-derived trait and uses this contract now. Speed,
context window, and mode remain application-curated until a provider exposes
authoritative runtime metadata for them. When that happens, add them using the
same tagged contract rather than optional arrays.

Semantics:

- `unknown`: the provider did not expose enough metadata. A curated fallback may
  be used when one exists.
- `unsupported`: the provider explicitly reports no support. Never revive a
  static fallback.
- `supported`: the runtime reports the exact allowed options. An empty options
  array is invalid and must decode as a probe/parser failure, not unsupported.

Keep argv construction and provider flags in trusted application code. Runtime
metadata supplies allowed IDs and labels, never arbitrary command fragments.

Use a versioned, strictly decoded inventory DTO:

```ts
interface AgentCapabilityInventory {
	schemaVersion: number;
	agentId: string;
	presetId: string;
	configRevision: number;
	detectedVersion: string | null;
	modelSource: "runtime" | "curated";
	models: AgentCapabilityModel[];
	inventoryCheckedAt: string;
}

interface AgentHealthObservation {
	status: "ready" | "unavailable" | "authentication_required" | "unknown";
	installed: boolean | null;
	auth: "authenticated" | "unauthenticated" | "unknown";
	checkedAt: string;
	errorKind:
		| "timeout"
		| "process_failure"
		| "parse_failure"
		| "missing_executable"
		| null;
	message: string | null;
}

interface AgentCapabilityView {
	agentId: string;
	presetId: string;
	inventory: AgentCapabilityInventory | null;
	inventoryOrigin: "live" | "persisted" | "none";
	health: AgentHealthObservation;
	healthOrigin: "live" | "persisted" | "none";
	refreshStatus: "idle" | "refreshing" | "backoff";
}
```

Inventory and health have separate timestamps and provenance because a transient
timeout can produce a live degraded health observation while the displayed model
inventory remains persisted.

Before persistence, fix and test the Antigravity parser so base models without
reasoning variants decode as `unsupported`, not `unknown`. Apply the same
distinction to Pi, OpenCode, Copilot, and every provider parser that emits trait
metadata.

## Provider policy

- Codex: prefer app-server/model cache metadata exposed by the installed Codex,
  including lifecycle and supported reasoning levels.
- OpenCode: prefer its runtime/verbose inventory, including upstream provider,
  variants, and agents.
- Pi: prefer structured RPC inventory and per-model thinking metadata.
- Cursor, Grok, Gemini/Antigravity, Copilot, and other capable tools: prefer
  documented session, SDK, or extension metadata when available.
- Claude Code: retain the curated version-gated catalog, custom models, and
  verified per-model traits. Refresh executable version and auth dynamically.
- Providers without reliable inventory: use a curated catalog only when health
  policy permits it and mark its source as `curated`.
- Superset chat: retain the application-owned catalog outside this cache.

## Persistence design

Persist host-scoped data in host-service SQLite next to `host_agent_configs`, not
in renderer storage or a global desktop cache. Each host has different binaries,
credentials, providers, and model access.

Add a monotonically increasing `capability_revision` to
`host_agent_configs`. Increment it only when discovery identity changes, which
currently means command, environment, preset restoration, or an equivalent
future discovery setting. Label, icon, and display-order changes do not
invalidate capability inventory.

Add `host_agent_capability_snapshots`, keyed by `agent_id`, with:

- `agent_id`, a foreign key to `host_agent_configs` with cascade delete;
- `preset_id`, for identity validation;
- `config_revision`, captured when the probe starts;
- `schema_version`, for strict decoding and future invalidation;
- nullable `inventory_json`, containing only `AgentCapabilityInventory`; it is
  cleared while the health row remains when an executable is confirmed missing;
- sanitized last-known `status` and `auth` values;
- `inventory_checked_at`, `status_checked_at`, and `written_at`;
- no raw errors, command output, resolver path, or environment data.

Never persist environment variables, API keys, command output, auth tokens, or
raw error logs. Do not use raw environment values in a persisted cache key.

Config mutations and persistence writes obey these race rules:

1. A probe captures `capability_revision` before spawning any process.
2. Updating a discovery-relevant config increments the revision and deletes its
   snapshot in the same transaction.
3. Before writing a probe result, re-read the config row in a transaction.
4. Persist only if agent ID, preset ID, and revision still match.
5. Discard an obsolete in-flight result instead of recreating the deleted row.
6. Restore-default, remove, and reset-to-default mutations follow the same rule.

Corrupt, mismatched, expired, oversized, or unknown-version rows are ignored and
deleted, never repaired heuristically.

Strict persistence limits:

- maximum serialized inventory size: 512 KiB;
- maximum models per agent: 2,000;
- maximum ID, label, provider, and option string length: 512 characters;
- duplicate model and option IDs are rejected;
- oversized live results are classified as parse failures and do not replace the
  last good inventory.

Keep the short in-memory TTL as the first-level cache. SQLite is the cold-start
cache, not a replacement for in-flight deduplication.

## Host-service API and refresh lifecycle

Split cache reads from expensive probes:

- `listCapabilitySnapshots`: returns memory, then persisted snapshots, without
  running a CLI.
- `refreshCapabilities`: probes configured agents, records live health,
  conditionally persists valid inventory, and returns the merged view.
- `ensureFreshCapability`: coalesces with an in-flight refresh and returns a
  short-lived validated capability lease for launch.

Refreshes are deduplicated by agent ID plus config revision. Use bounded
concurrency across agents. A config update may start a new revision without
waiting for the obsolete revision, but the obsolete result cannot be persisted.

The renderer requests refresh on first use and on window focus only when data is
stale. Launch requests freshness only for the selected agent. Refresh work is
owned by the app lifecycle:

- it accepts an `AbortSignal`;
- child probes terminate on abort or timeout, with a forced-kill fallback;
- retry eligibility uses bounded exponential backoff without scheduling timers;
- `dispose()` clears retry state, aborts probes, awaits settlement, then closes the
  database;
- tests use injected clocks, probe runners, and concurrency limits.

Refresh merge rules:

- A successful authoritative probe atomically replaces inventory and health.
- A successful curated probe records curated inventory and live health.
- Confirmed unauthenticated state replaces health immediately but retains prior
  inventory only as disabled display metadata.
- Confirmed missing executable replaces health, clears memory, and deletes the
  persisted inventory.
- Timeout, process failure, or parse failure preserves last-good inventory,
  records separate live health/error metadata, and schedules bounded exponential
  backoff.
- A successful authoritative list replaces the old list. Never merge retired
  models into it.
- Raw stderr/stdout never crosses the API or enters SQLite.

## Renderer flow

`useV2AgentChoices` is the single shared capability consumer:

1. Query cached snapshots immediately without probing a CLI.
2. Render cached ordering without waiting for refresh.
3. Ask a shared query/mutation controller to refresh only stale agents needed by
   the active surface, not one effect per picker.
4. Coalesce first-use and window-focus refreshes by host URL, agent ID, and config
   revision.
5. Replace query data with the returned merged view atomically.
6. Preserve existing data while reads or refreshes are pending.
7. Reconcile persisted model and trait selections only after a successful
   authoritative refresh explicitly removes them.
8. Keep cached inventory visible but disable it when live health reports missing
   authentication. When a live probe confirms a missing executable, clear its
   inventory, retain the timestamped health row, and hide the agent.

The always-mounted, closed workspace modal may hydrate from
`listCapabilitySnapshots`, but it must not call the refresh mutation until a
surface that needs the choices is actually open.

All workspace-create, task, automation, resume, and in-workspace new-agent
surfaces must consume this shared hook and capability map. Do not implement
separate refresh behavior in individual pickers.

## Launch-time safety

A cached choice is display data, not launch authority. Introduce an async
`ensureFreshCapability(config, selection)` boundary before terminal launch:

- reuse an in-flight refresh when one exists;
- require a live result no older than the short launch TTL for account-dependent
  providers;
- verify executable, authentication policy, model ID, and every explicit trait;
- reject selections removed by the authoritative inventory;
- return an actionable typed error and invalidate renderer queries;
- never silently omit an invalid model/trait flag and fall back to the CLI
  default;
- allow curated Claude models only when its live version/auth policy passes.

The validated result becomes a short-lived capability lease containing agent ID,
config revision, inventory timestamp, and allowed selection. Pure synchronous
command construction accepts that lease instead of consulting an arbitrary
cached snapshot.

Cover every launch path:

- direct `agents.run` and resume;
- `createSession`;
- synchronous workspace creation;
- `createEnqueued`, which becomes async for preflight before enqueueing work;
- setup-terminal chaining;
- task and automation dispatch.

Run async capability preflight before workspace filesystem, database, or cloud
side effects. For setup-terminal chaining, preserve the exact validated model
argument in the chained command. If auth changes while setup runs, the CLI may
fail visibly, but Superset must not silently drop the model and launch a default.

## Executable resolution and portability

Do not inspect npm, Bun, pnpm, or other package-manager caches. Their internal
layouts are not executable discovery contracts and may contain stale or evicted
packages. Capability snapshots come only from the configured installed runtime,
never from a package-manager cache.

Use an ordered, testable resolver:

1. Explicit absolute command configured by the user.
2. Native executable found on the terminal's effective `PATH`.
3. A later native executable on `PATH` when a recognized wrapper appears first.
4. The original configured wrapper with a provider-appropriate timeout.

Keep resolver metadata such as source, detected version, and in-memory path for
diagnostics. Do not persist the resolved path. Never scan every package cache for
every provider. Prefer the same resolved executable for discovery and launch
when practical, or record when probing bypasses the configured launch wrapper.

Platform coverage includes macOS ARM64/x64 and Linux. Preserve correct Windows
path and `.cmd` handling even while Windows is not the primary desktop target.

## Implementation slices

### Slice 1: Make capability semantics explicit

- [x] Introduce the tagged trait contract for runtime reasoning. Reuse it for other
  traits only when runtime discovery for those traits exists.
- [x] Fix Antigravity unsupported-versus-unknown reasoning detection.
- [x] Add parser tests for providers with no reasoning, exact reasoning options, and
  malformed trait metadata.

### Slice 2: Persistent host snapshots and revision safety

- [x] Add `capability_revision`, the snapshot table, and a generated host-service
  Drizzle migration.
- [x] Add strict versioned encode/decode and repository helpers.
- [x] Reject duplicate IDs and oversized inventories during strict decoding.
- [x] Invalidate snapshots transactionally on relevant config mutations.
- [x] Reject obsolete in-flight writes by revision.
- [x] Test restart hydration, corruption, identity mismatch, expiry, limits, secret
  exclusion, and update-during-probe races.

### Slice 3: Stale-while-revalidate API and lifecycle

- [x] Split cached reads, refresh, and launch freshness operations.
- [x] Add per-revision in-flight deduplication, bounded concurrency, and
  last-good merge rules.
- [x] Add demand-driven stale checks and retention cleanup. Startup does not
  probe CLIs.
- [x] Add app-owned disposal and cancellation for spawned CLI probes.
- [x] Add demand-driven retry/backoff and typed timeout/process/parse
  classification.

### Slice 4: Cache-first renderer

- [x] Render persisted snapshots immediately in `useV2AgentChoices`.
- [x] Centralize stale-only first-use and focus refresh by host URL and agent ID.
- [x] Replace query data atomically without selection or scroll resets.
- [x] Cover workspace creation, tasks, automations, resume, and in-workspace
  launches through the shared hook.

### Slice 5: Portable executable resolver

- [x] Extract executable resolution from the capability probe module.
- [x] Add explicit/PATH/wrapper stages and in-memory source metadata without
  inspecting package-manager caches.
- [x] Add macOS, Linux Omarchy, native-over-wrapper, path-with-spaces, and
  Windows `.cmd` tests.

### Slice 6: Async launch validation and diagnostics

- [x] Add `ensureFreshCapability` and the validated capability lease.
- [x] Convert every preflight boundary that needs live discovery to async.
- [x] Remove silent model/trait fallback from validated launch paths.
- [x] Add typed errors for retired models, unsupported traits, expired auth, missing
  binaries, and config changes during validation.
- [x] Expose inventory age/origin, health age/origin, resolver source, and
  sanitized last error kind for the future Health Center.

## Validation gates

- [x] Unit tests cover provider parser unknown/unsupported/supported behavior.
- [x] Persistence tests use temporary host SQLite databases and simulated
  restart.
- [x] Race tests prove an old probe cannot repopulate a snapshot after config update,
  restore, reset, or deletion.
- [x] Resolver tests use fake executables and wrappers for supported executable
  formats and platform path semantics.
- [x] Concurrency tests prove multiple picker mounts and focus events launch at
  most one stale probe per agent revision.
- [x] Startup tests prove snapshot hydration and retention cleanup spawn no agent
  processes.
- [x] Freshness tests prove a picker inside the 5-minute window and a launch inside
  the 30-second window reuse the live result without another probe.
- [x] Lifecycle tests prove shutdown clears retry state and cancels child probes
  before the database closes.
- [x] Failure tests cover timeout, auth loss, binary removal,
  corrupt/expired/oversized
  cache, changed command/environment, and a model retired between snapshot and
  launch.
- [x] Launch-path tests cover direct run, resume, session creation, synchronous and
  enqueued workspace creation, setup chaining, tasks, and automations.
- Desktop end-to-end evidence recorded on 2026-08-14:
  - [x] first cold run with no cache showed honest `Loading agents...` state;
  - [x] after discovery, the selected Antigravity, Gemini 3.6 Flash, and High
    choices rendered in the real picker;
  - [x] a restart with 15 intentionally stale snapshot rows rendered models in
    605 ms while only 2 rows had completed revalidation;
  - [x] after background refresh completed, all 15 rows were refreshed while the
    selected agent, model, effort, and scroll position remained unchanged;
  - [x] console errors remained empty throughout the sampled cold-start and
    stale-refresh lifecycle;
  - [x] simulate an inaccessible cached model launch at the renderer and
    launch-contract boundaries with isolated fake capability data;
  - [x] simulate config mutation during an active delayed probe and prove the
    obsolete result is rejected;
  - [x] simulate two connected-host lifecycles with isolated service instances,
    host-scoped renderer keys, caches, invalidation, and refresh coalescing.
- [x] Focused suites pass: 228 host/shared tests, 35 desktop tests, and 4
  automation tests.
- [x] Root typecheck passes all 37 tasks.
- [x] `bun run lint:fix`, `bun run lint`, and `git diff --check` pass.
- [x] Desktop verification records the exact worktree, renderer URL, route,
  signed-in session, screenshots, timings, state measurements, and console errors.

The desktop evidence used this worktree, renderer `http://localhost:3085`, route
`#/new-workspace`, and dedicated CDP port `9333`. The local seeded account was
signed in through real pointer input. Screenshots were captured before and after
restart. The three environmental scenarios were completed on 2026-08-15 as
controlled simulations using fake executables and temporary SQLite databases.
Ten focused tests covered missing-executable launch preflight, config-revision
races, two isolated host-service instances, host-scoped renderer keys and
invalidation, and per-host refresh coalescing. They are acceptance simulations
and are not claimed as manual desktop E2E evidence against real remote machines
or globally installed agent CLIs.

## Out of scope

- Replacing Claude's curated model catalog without a reliable upstream discovery
  contract.
- Treating third-party provider APIs as substitutes for the user's installed CLI
  and authenticated account.
- Sharing capability snapshots between hosts.
- Installing or updating agent CLIs automatically.
- Persisting raw CLI output, environment values, secrets, or executable paths.
- Building the full Health Center UI. This plan exposes only the diagnostics that
  a future Health Center can consume.
