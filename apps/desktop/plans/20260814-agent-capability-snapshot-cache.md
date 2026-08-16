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
- [x] Split cached reads from host-owned refresh and remove closed-surface probes.
- [x] Render cache-first from persisted snapshots; each renderer session owns
  one asynchronous revalidation per selected host, including after `Ctrl+R`.
- [x] Validate launch selections from persisted/runtime or curated trusted IDs
  without probing agent CLIs or gating terminal creation on health/auth.
- [x] Move refresh ownership into the app lifecycle with probe cancellation and
  safe disposal before SQLite closes.
- [x] Add typed timeout/process/parse diagnostics without retry timers or
  backoff that could suppress an explicit refresh.
- [x] Cover every launch path, including linked presets and fresh-workspace
  automation, with the same async capability preflight.
- [x] Resolve installed executables from explicit configuration and `PATH`
  without reading npm, Bun, pnpm, or other package-manager caches.
- [x] Keep executable presence as a filesystem-only first stage: stop at the
  first ordinary PATH match, scan farther only to bypass a recognized package
  wrapper, and never spawn a missing CLI.
- [x] Validate the cache-first lifecycle in the real desktop app on Linux.

## Baseline and prerequisite ownership

The active feature branch contains the expanded runtime capability layer:

- revision-scoped in-flight deduplication without a temporal process cache;
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

Opening the authenticated renderer reads persisted snapshots immediately.
Revalidation is owned by the renderer session and explicit configuration
actions:

1. Read the most recent valid snapshot for this host without running a CLI.
2. Render usable cached choices immediately when the snapshot is within the
   display-age policy.
3. The authenticated shell revalidates the active host once per renderer
   session. `Ctrl+R` creates a new session and therefore a new refresh.
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

## Refresh policy

The host only hydrates and prunes SQLite during startup. It never probes an
agent CLI until an explicit refresh RPC or relevant config mutation arrives.
The authenticated renderer keeps one host-scoped refresh query alive for its
entire session. Multiple picker mounts share it; focus and reconnect do not
refetch it; `Ctrl+R` creates a new `QueryClient` and intentionally probes again.
There is no polling or freshness TTL. Config and snapshot queries also avoid
focus refetches so a renderer session cannot combine a newly observed external
config with an older capability snapshot; `Ctrl+R` starts a consistent session.

Changing `command` or `env`, restoring a default, and adding/resetting configs
refresh only the affected config(s) before their mutation resolves. Launch reads
the latest valid snapshot and curated catalog without probing. Simultaneous
explicit probes for the same agent revision share one in-flight promise.

Every real probe observation is persisted. The persisted table stores one
current row per agent and overwrites it; it is not an observation history.

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

SQLite is the cold-start cache; in-flight deduplication is keyed by agent ID and
config revision. No capability freshness TTL is used.

## Host-service API and refresh lifecycle

Split cache reads from expensive probes:

- `listCapabilitySnapshots`: returns persisted snapshots without running a CLI.
- `refreshCapabilities({})`: explicitly probes the configured agents and returns
  the resulting persisted views; targeted `agentIds` probe only those agents.
- Launch validation reads the current revision-matched snapshot and never calls
  a discovery CLI.

Refreshes are deduplicated by agent ID plus config revision. Use bounded
concurrency across agents. A config update may start a new revision without
waiting for the obsolete revision, but the obsolete result cannot be persisted.

Refresh work is owned by the renderer session and config mutations:

- it accepts an `AbortSignal`;
- child probes terminate on abort or timeout, with a forced-kill fallback;
- every explicit refresh is honored; there is no retry/backoff state;
- `dispose()` aborts probes, awaits settlement, then closes the database;
- tests use injected clocks, probe runners, and concurrency limits.

Refresh merge rules:

- A successful authoritative probe atomically replaces inventory and health.
- A successful curated probe records curated inventory and live health.
- Confirmed unauthenticated state replaces health immediately but retains prior
  inventory only as disabled display metadata.
- Confirmed missing executable replaces health, clears memory, and deletes the
  persisted inventory.
- Timeout, process failure, or parse failure preserves last-good inventory,
  and records separate live health/error metadata.
- A successful authoritative list replaces the old list. Never merge retired
  models into it.
- Raw stderr/stdout never crosses the API or enters SQLite.

## Renderer flow

`useV2AgentChoices` is the single shared capability consumer:

1. Query cached snapshots immediately without probing a CLI.
2. Render cached ordering without waiting for refresh.
3. Start one explicit refresh per selected host and renderer session. `Ctrl+R`
   intentionally creates a new session; focus and reconnect do not refresh.
4. Write the returned view into the snapshot query cache atomically.
5. Never merge a second refresh-data source over snapshots.
6. Preserve existing data while reads or refreshes are pending.
7. Reconcile persisted model and trait selections only after a successful
   authoritative refresh explicitly removes them.
8. Keep cached inventory visible but disable it when live health reports missing
   authentication. When a live probe confirms a missing executable, clear its
   inventory, retain the timestamped health row, and hide the agent.

The always-mounted workspace modal owns the active-host session refresh so a
normal app entry and `Ctrl+R` update capabilities before the picker opens.

All workspace-create, task, automation, resume, and in-workspace new-agent
surfaces must consume this shared hook and capability map. Do not implement
separate refresh behavior in individual pickers.

## Launch-time safety

Superset creates a terminal session; the CLI owns runtime authentication and
execution failures. Launch validation therefore performs no capability probe
and does not block on persisted health. It still:

- verifies the configured agent and config revision;
- validates model and trait IDs against revision-matched runtime inventory or
  trusted curated catalogs;
- rejects unknown runtime-only values when no snapshot exists;
- never silently omits an invalid model/trait flag and falls back to the CLI
  default;
- returns a branded selection consumed by pure command construction.

Cover every launch path:

- direct `agents.run` and resume;
- `createSession`;
- synchronous workspace creation;
- `createEnqueued`, which becomes async for preflight before enqueueing work;
- setup-terminal chaining;
- task and automation dispatch.

Run selection preflight before workspace filesystem, database, or cloud side
effects. For setup-terminal chaining, preserve the exact validated model
argument. Missing executables or expired auth fail visibly inside the terminal.

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

This presence stage follows the same useful boundary as Orca's CLI detection:
filesystem/PATH resolution is separate from provider-specific capability
discovery. Superset retains the deeper second stage because the picker must know
host-specific authentication, models, and traits. Only a resolved executable may
reach that stage; missing agents produce health observations without spawning a
process.

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

### Slice 3: Explicit refresh API and lifecycle

- [x] Split cached reads, explicit refresh, and launch validation operations.
- [x] Add per-revision in-flight deduplication, bounded concurrency, and
  last-good merge rules.
- [x] Add retention cleanup and one asynchronous refresh per selected host and
  renderer session.
- [x] Add app-owned disposal and cancellation for spawned CLI probes.
- [x] Add typed timeout/process/parse classification without retry/backoff.

### Slice 4: Cache-first renderer

- [x] Render persisted snapshots immediately in `useV2AgentChoices`.
- [x] Run one renderer-owned refresh per host URL without focus, reconnect, or
  TTL refetches; `Ctrl+R` intentionally creates another session.
- [x] Replace query data atomically without selection or scroll resets.
- [x] Cover workspace creation, tasks, automations, resume, and in-workspace
  launches through the shared hook.

### Slice 5: Portable executable resolver

- [x] Extract executable resolution from the capability probe module.
- [x] Add explicit/PATH/wrapper stages and in-memory source metadata without
  inspecting package-manager caches.
- [x] Add macOS, Linux Omarchy, native-over-wrapper, path-with-spaces, and
  Windows `.cmd` tests.

### Slice 6: Snapshot-backed launch validation and diagnostics

- [x] Add a branded validated launch selection backed by the current snapshot
  and trusted static transport metadata.
- [x] Keep every launch preflight free of discovery processes.
- [x] Remove silent model/trait fallback from validated launch paths.
- [x] Add typed errors for retired models, unsupported traits, selection
  mismatch, and config changes during validation. Auth and binary failures belong
  to the terminal CLI.
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
- [x] Concurrency tests prove multiple picker mounts share one session refresh,
  focus does not refresh, and a new `QueryClient` refreshes again.
- [x] Startup tests prove snapshot hydration itself spawns no process.
- [x] Launch validation tests prove persisted auth health does not block launch
  and runtime-only unknown models remain rejected without probing.
- [x] Lifecycle tests prove shutdown cancels child probes before the database
  closes.
- [x] Failure tests cover timeout, auth loss, binary removal,
  corrupt/expired/oversized cache, changed command/environment, and an unknown
  model at launch.
- [x] Launch-path tests cover direct run, resume, session creation, synchronous and
  enqueued workspace creation, setup chaining, tasks, and automations.
- [x] Focused suites pass: 142 host-service tests and 21 desktop renderer tests.
- [x] Host-service typecheck passes.
- [x] Biome checks for every changed TypeScript/TSX file and `git diff --check`
  pass.
- [ ] Desktop-wide typecheck and manual E2E remain to be rerun in a fully bootstrapped
  workspace. This checkout does not have the `tsr` executable or generated
  `routeTree.gen.ts`; focused renderer tests cover the changed session lifecycle.

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
