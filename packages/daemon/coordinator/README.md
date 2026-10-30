# Native project tools

`Coordinators.open()` installs `nativeTools(storage, options)` by default, then
applies explicit `tools` overrides. The existing admitted `CoordinatorStorage`
is their writer capability. A second manager/storage for the same project on
that daemon's EventStore is refused. Closing it fences old tool handles before
a successor can open it. The daemon still owns its single EventStore; this is
not cross-process SQLite locking. Worker and merge execution will add their
leases inside this capability in Specs 3/4, rather than introduce another writer.

Every call returns JSON facts in both `details` and a JSON text block. Refusals
have `ok: false`, `code`, `message` and `next`. Writes run sequentially. Fleet
status and inbox read only the admitted project's folded events; status lists
facts the current fold cannot supply under `unavailable`, rather than inventing
a frontier, runtime observation or launch capacity.

The five mutations (`inbox.answer`, `hold.add`, `hold.clear`, `owner.ask`,
`rules.set`) use pi's durable `(project, taskId, callId)` as their operation identity.
An effect and its `payload.receipt` commit in one EventStore append. Replay
returns the committed result, even if the item's current state has changed;
reusing the identity with different arguments refuses. Generated item IDs are
`tool:<sha256(identity)>`, scoped by project. The native projection strips receipt metadata from ordinary hold and inbox
records; raw log events retain it for replay. A failed append publishes
no success receipt. No external effect is inferred from a local checkpoint.

`inbox.answer` copies V1's question/plan and generation guards. It preserves the
worker's phase. Inject `native.deliverAnswerOnce` to deliver with a stable key;
the adapter must deduplicate that key across restarts and invoke `beforeWrite`
immediately before each runtime write. Missing/unconfirmed delivery leaves the
item open. A replacement or ended session is fenced before delivery and again
before recording. Do not adapt an unkeyed send API by retrying it. This ticket
supplies the orchestration contract; Spec 3 supplies runtime adapters. Owner
requests and hand-backs cannot be dismissed with `inbox.answer`.

`merge.check` copies the applicable V1 checklist (source comments identify it),
including a full pinned hand-back SHA, phase, checks, title, draft, threads,
validations and holds. Inject `native.mergeEvidence` for the facts the fleet
fold lacks. Evidence belongs to the exact head; it must include required check
names and explicit check-enumeration completeness, all visible check states,
consistent review-thread counts and completeness, acceptance/owner approval
pinned to the current head, and a test pinned to both current head and base.
The reading timestamp must fall within the adapter call; malformed, cached or
partially enumerated evidence refuses. Missing evidence refuses. The tool re-reads the
fleet after an asynchronous read. A successful check is a reading, never a
merge authorization that can be reused after state changes. Spec 4 must run the
checklist again under its merge lease, against fresh base/head evidence.

`rules.set` patches routing, placement and policy using `expectedRevision` from
`fleet.status.rules`; stale revisions refuse. Routing is an ordered list of
`{labels, cli: claude|codex|opencode, model, effort?}` or `{when, cli, model, effort?}`,
where `when` describes a kind of work for the coordinator to judge. `defaultRoute`
is an optional CLI/model/effort fallback (null clears it). Placement selects `local`
or `vm` separately for workers and coordinator. Policy uses `plans` (`approve` or `pre-approved`), optional `approvalLabel` and
`preApprovedLabel` (defaults `needs-plan-approval` and `plan-approved`), `silenceMinutes`,
`quietMinutes` (finite positive numbers) and nullable `maxWorkers` (a positive
safe integer or no cap); policy patches retain omitted numbers. A reason is mandatory.

Rules remain versioned `coordinator.checkpoint` events with reserved
`format: armada.tools`, `version: 1`, `type: rules`, `rules: {revision,value}`.
The protocol owns the rule schemas; the native tool derives its JSON Schema
from that definition and the app reads it directly. The shared fold projects
them into `ProjectTables.rules`, sent live with each
project's snapshot. Revision 0 and an empty value mean no rules have been set;
unset policy numbers leave worker capacity uncapped; worker execution defaults to local placement and Claude when no defaultRoute is set. A null defaultRoute refuses launch. Existing
v1 checkpoints replay unchanged. Pi storage ignores this format. The event log,
owned by the app's daemon independently of repository files, is the only authority;
plugin switches continue to use the separate app configuration file.

Instead of `rules`, pass `importFile` with an absolute path to a V1 armada.toml
on the daemon's machine to import once into a project at revision 0. The local
adapter reads a regular UTF-8 file of at most 256 KiB; hosts can restrict it with
`native.readRulesImport`. The file's contents never become model tool arguments:
only its reference and normalized rules enter the durable conversation and log.
Do not paste file contents into chat. The import reads `conductor.routing` in file
order, profile `when` descriptions after label routes, the default profile, and
`policy.silence_minutes` (or its old `silent_after_minutes` alias), `quiet_minutes`
and `max_workers`, as well as explicit `plans`, `approval_label` and `pre_approved_label`, including V1 defaults (15, 45, no cap). Only those fields are
read; tracker/forge/secrets and other V1 tables are not imported.
Malformed input, unknown profiles, unsupported CLI agents, fast mode, or herdr
routing refuse atomically instead of losing intent. Runtime wrappers such as
Conductor are not V2 runtimes and do not establish placement: tell the coordinator
where to run workers and itself after importing. After the file read, ownership
and revision are checked again. A later import refuses even if all rules were
subsequently cleared; replaying a committed call returns its receipt without
reading a changed or removed source file.

The app's project page shows these folded rules in a read-only block. Tell the
coordinator new intent through its chat; the app never reads armada.toml directly.
Model catalog validation and placement execution belong to the launch implementation;
storing intent does not claim a provider or VM is available.

With the host’s `Workers` service, all four `worker.*` actions use the loaded node
and runtime registry; see the daemon README’s Local worker plugins contract.
Launch/relaunch requires a successful new tracker reading before preflight and builds
a ticket-derived brief with pinned CLI install/exec fallback and the worker skill. Worker refusals expose safe rule messages; arbitrary provider errors remain
fixed credential-free diagnostics. Missing worker or merge services return `not_available_yet`, naming the missing capability;
configured merge tools use the shared worker stop/disposal path after confirmation. No native tool imports V1 core.
