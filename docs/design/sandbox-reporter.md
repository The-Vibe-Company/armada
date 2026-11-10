# Sandbox reporter: Boat usage first, reuse existing supervision

Design proposal for [#878](https://github.com/The-Vibe-Company/armada/issues/878),
inspected against main at `2fce2ef6bc993d0516e1642f3f0ca42f198b8270`.
No behavior, installation, migration, or deployment changes are made here.
Armada remains a launcher: reports inform owners and orchestrators; they do not
schedule tasks, judge work, merge branches, or implement orchestration policy.

## What runs today

Paths below are repository-relative. These are code observations, not claims
that every existing golden or production sandbox has the newest artifact.

| Placement / harness | Resident components and reporting | Authority and channel |
| --- | --- | --- |
| Boat / Claude | Boat runs the native harness; `packages/provider-boat/src/provider.ts` calls Boat prompt/status/events APIs. `events.ts` maps messages, tools, prompt states and unknown native events to `AgentEvent`. This is **not** Armada's Modal Runner. | Armada holds the provider key server-side. Boat owns native supervision; Armada pulls cursor pages, not a guest callback. |
| Boat / Codex | Same provider-mediated path, with native cwd wrapper in `packages/provider-boat/src/native-cwd.ts`. Native event availability is Boat-dependent; do not assume parity with the managed Codex driver. | Same Boat API authority, with harness-specific capabilities (including steer fallback). |
| Modal / Claude | `packages/provider-modal/src/distribution.ts` installs pinned tools and bundled runtime. Its launcher uses `flock`, a clean environment and `runuser` to execute `/opt/armada/main.js` as user. `packages/agent-runtime/src/main.ts` receives private stdin bootstrap, creates the journal and private HTTP Runner. `claude.ts` drives the Claude SDK and emits messages, model/usage frames and native result/error observations. | Private Runner RPC uses `x-armada-runner-grant`; bootstrap includes an expiring sandbox/generation grant, not an owner token or database key. Native model credentials are separate. |
| Modal / Codex | Same launcher/Runner; `packages/agent-runtime/src/codex.ts` starts the Codex app-server, associates thread/turn identity, emits terminal notifications and `armada/turnUsage`, and reads account rate limits. Token deltas can be unknown without a trustworthy baseline; unknown is not zero. | JSON-RPC over the local harness process channel; Runner journals events and pushes batches to server ingest. |

The managed runtime is already a resident reporting service on Modal.
`packages/agent-runtime/src/runtime.ts` transitions prompts, records failure reasons,
flushes an outbox and validates acknowledgements. `journal.ts` uses SQLite WAL,
monotonic sequence numbers, redaction and atomic prompt transitions. It also
stores prompt text and general events: **that journal is not a safe telemetry
schema**. `packages/provider-modal/src/ingest.ts` accepts bounded batches under a
verified sandbox/generation grant and persists through `store.ts`. The same private
ingest implementation has a distinct native-auth publication lane; a telemetry
grant must never inherit that credential-writing privilege.

Other existing residents are not general reporters:

- **GitHub broker:** `packages/agent-runtime/src/github-broker.ts` and
  `github-tools.ts` mediate local git/gh calls with runtime configuration.
  Modal starts this through `main.ts`; Boat uses the separate bundled
  `github-boat-main.ts`, installed by `packages/mcp-server/src/github-boat.ts`
  over pinned SSH/private stdin. A local socket and activation protect access;
  GitHub authority is a separate capability, not report-ingest authority. The
  broker transports GitHub operations, not token-cost or liveness telemetry.
- **Orchestrator parent MCP:** `packages/mcp-server/src/orchestrator-bootstrap.ts`
  installs the launcher tool reference and optional skill with a receipt.
  `orchestrator-scoped-gateway.ts` exposes only delegated child operations.
  Boat's `boat-orchestrator-script.ts` maintains a loopback proxy with an
  in-memory, epoch-fenced credential; `boat-orchestrator-bridge.ts` installs
  `armada_orchestrator` configuration. Modal's Runner installs/scrubs epoch
  authority (`protocol.ts`, `runtime.ts`). Harness-configured MCP connections
  (`packages/agent-runtime/src/mcp.ts`, `mcp-file.ts`) can also start stdio
  descendants or connect to HTTP servers. These exchange tool requests/results,
  not generic health reports. They must retain their own authority and shutdown
  ownership; do not borrow a parent's delegation token for telemetry.
- **Golden init:** `packages/core/src/golden-config.ts` and `launch.ts` execute
  configured repository pulls and init commands. Those commands can start project
  services; no universal service inventory or reporting guarantee follows from
  having a golden. Detached init results are refused by the launch flow. A
  project's arbitrary background service is not automatically a managed reporter.
- **Existing consumers:** `packages/mcp-server/src/turns.ts` and
  `orchestrator-event-worker.ts` reconcile turn state. `model-usage.ts` and
  `model-usage-codex.ts` interpret account-private native readings;
  `packages/core/src/sandbox-usage.ts` handles sandbox usage projections.
  `resource-store.ts` / `resource-advice.ts` consume resource observations.
  Boat already samples fixed resource files through the provider;
  Modal's `resourceObservation` uses
  `packages/agent-runtime/src/resource-sampler.ts`. Its own comment requires
  provider-attested VM isolation: a guest cannot establish that isolation.

## Production evidence and the coverage gap

On 2026-11-10 the coordinator supplied a production check: one trivial turn per
provider/harness, inspected through the public events API. **These observations
were supplied, not reproduced by this design author; no production access was
performed for this revision.**

| Observed placement | Events Armada received | Status usage |
| --- | --- | --- |
| Boat / Claude Code | One prompt and one message; no usage event | `turns: []`, `turnCount: 1`, `computeSeconds: null` |
| Boat / Codex | One prompt and one message; no usage event | Same empty usage |
| Modal / Codex | Twelve `other` events, including one `armada/turnUsage` | Token usage populated |

This is evidence of a missing **source on Boat**, not just a parser or delayed
consumer. `packages/core/src/sandbox-usage.ts` only projects native final usage
snapshots from `result.modelUsage` or `armada/turnUsage`. More polling of the
observed Boat stream cannot create those records. The result does not establish
what is on the guest disk or whether Boat invokes configured hooks. Those remain
explicit implementation validation requirements, not production facts.

The owner's first outcome is per-sandbox tokens/cost and the selected account's
subscription limits (#873/#874/#875), especially on Boat where the coordinator
reports most sandboxes run. A Modal-only lifecycle pilot does not deliver that.
Reuse the existing accounting projections, **but add a real Boat collection
source first**. Cost consumes measured tokens using #875's versioned price
function; do not introduce a second ledger or a new server pricing requirement.
Subscription limits are account-wide, not tokens divided by an imagined quota.
A sandbox may display its pinned account's authorized, timestamped reading, not
claim that sandbox alone consumed the shared allowance.

## What is worth reporting

Priority ranks incremental value, not permission to expose everything already
available in a native event stream. Every reading needs source, observation time,
server receive time, freshness and an explicit unavailable/unsupported state.

| Rank | Report | Boundary / caveat |
| --- | --- | --- |
| 3 | Turn started/finished/failed/interrupted, harness reason code, turn/model identity | Link to admitted prompt/conversation; preserve native reason as a closed code, not arbitrary stderr. Guest terminal claims do not prove machine stop. |
| 1 | Per-turn input/output/cache tokens, observed model and usage provenance | Separate requested from observed model. Preserve unknown/reset/partial counters; deduplicate deltas. Cost is a server-derived estimate with price/version, never an invoice or subscription charge. |
| 2 | Subscription windows, reset times and limit status | Account-private, pinned credential identity/revision; not an org-visible sandbox message. No account identifiers or raw native payloads in the common report. Never manufacture a Claude limit by scraping rendered text. |
| 4 | Git branch, ahead/behind counts, dirty boolean | Addresses unpushed-work risk (#747). Registered repo IDs only, bounded local reads, no network fetch or auto-push. Behind may be stale against local tracking refs. Branch names are untrusted strings: sanitize, cap and owner-scope them. No diffs or filenames. |
| 5 | Harness, CLI, runtime and report-schema versions; time to ready | Emit once per incarnation. Server launch timestamps plus guest ready observation; distinguish restored from cold launch. No executable paths, environment dump or host fingerprint. |
| 6 | Heartbeat and expiry context | Sparse while active; silence means unknown, not dead. Server/provider remains authority for TTL/time left (#851), using its own clock, not a guest assertion. |
| 7 | CPU, memory, disk pressure | Reuse fixed-file sampler and provider provenance, sample coarsely/on demand. Do not infer VM totals from untrusted container host counters. No process argv or per-file disk inventory. |
| 8 | Installed skills | Prefer existing bootstrap receipt and bounded declared name/version IDs. No skill contents, directory crawl or user-home inventory; receipt is not proof a skill was actually used. |

Failures should expose bounded stage/code/version diagnostics, enough to locate a
failed boundary without forcing coordinators to read raw logs. They must not ship
stack traces, paths, or command output under a supposedly safe `reason` field.

## Options

All options must treat a compromised guest as capable of forging *its own*
measurements and reading any guest-accessible credential. Authentication proves
which sandbox submitted bytes, not that CPU, git or token claims are truthful.
No option grants a sandbox provider credentials, SQL access or owner authority.

### A. Extend the runtime/Runner with common structured reports (Modal path)

On Modal, reuse supervision, driver parsing, durable sequence/ACK mechanics and
checkpoint ownership. Add a separate allowlisted report lane, not raw `other`
events. On Boat, keep provider events as canonical lifecycle input, but collect
usage separately as specified below; Boat event normalization alone is insufficient.
Do **not** silently replace Boat's harness launcher with the Modal Runner.

- Reliability/latency: near-immediate durable push when connected; bounded spool,
  retries with backoff/jitter and at-least-once delivery with deduplication. Keep
  pull reconciliation for dropped callbacks, old artifacts and offline periods.
  Prioritize terminal records; coalesce/drop old samples before filling disk.
- Security: distinct short-lived append-only report capability, bound to one
  sandbox and physical incarnation, verified against current server state.
  No command execution, native-auth publication or delegation using this token.
  Strict schema/size/rate limits on both sides; reject unknown keys, raw blobs,
  invalid turn ownership and stale generations. Private account usage uses a
  separate authorized projection. Redaction is defense in depth, not the schema.
- Cost: no extra Modal resident process; extra ingress/storage and server wakeups.
  Batch metrics but flush lifecycle promptly. Boat collector introduces lifecycle
  integration work; production evidence already establishes the need for a source
  beyond provider event pulls.
- Golden/lifecycle: bundled Modal runtime overlay is already supported by
  `packages/provider-modal/src/runtime-overlay.ts`; restored checkpoints are not
  arbitrary fresh-install targets. Protocol negotiation must accept old artifacts
  as unsupported. Boat collector needs an explicit supported bootstrap or golden
  rebuild/version path, not an assumption that all goldens update themselves.
- Docker/Kubernetes: share schema, spool and driver adapters behind a transport
  interface; provider placement supplies identity and lifecycle. Later run under
  the container supervisor, not a Modal-specific endpoint embedded in a golden.

### B. Separate daemon installed in goldens

Independent of harness version and able to sample idle machines; potentially low
latency with durable spool, but another process, updater, queue and health state.
It cannot reliably infer harness terminal reasons or account limits without
integrating the same native adapters. Costs memory/CPU and rollout/rebuild work
for every golden; stale installations are inevitable.

Give it only the same append-only generation-scoped report capability, injected
at launch, never baked into a snapshot. Compromise still forges local readings.
It must be an explicitly owned shutdown participant across stop/resume, drain
before snapshot, scrub credentials and restart with new authority. An unmanaged
writer risks precisely #732. A Kubernetes sidecar is plausible later but brings
shared-volume permissions and shutdown ordering, not automatic reliability.
Not justified while Modal already has the resident runtime.

### C. Harness hooks / Codex notify to a local spool

Useful as optional hints where provider events omit a signal. Proposed hooks
must be checked against the pinned harness versions before implementation; this
design does not assume a universal hook, payload or guaranteed delivery.
No network credential is needed in the hook if only the collector uploads.

Low startup cost but harness/configuration coupling, hook conflicts, missed
crashes and duplicate notifications. Never forward hook input wholesale: it can
contain prompts, paths and results. Apply a small allowlisted extractor and
bounded atomic spool writes; collector authentication remains necessary. Polling
the spool adds latency unless integrated into supervision. Golden config changes
or launch-time hook injection need explicit ownership/versioning. Stop must wait
for hook descendants and spool writers; resume deduplicates old records without
restoring credentials. Container hooks share the same caveats. Hooks alone are
not a durable lifecycle protocol. A separate narrowly scoped local usage extractor
may read numeric fields from an admitted session file, never export its contents.

### D. Keep pulling

Lowest incremental operational/security cost; retains current provider key only
on the server and no new guest credential or golden rebuild. Reconcile through
provider status/events, and use existing bounded resource observations. However,
latency depends on polling/backoff, repeated calls cost money and server capacity,
and missing native fields remain missing. Crashes between polls may lose ephemeral
observations; stale is not zero. Stop/resume retain existing cursor/generation
rules. Docker/Kubernetes would need a provider event/status adapter anyway.
Keep this as fallback, not the long-term latency solution; do not simply increase
polling frequency globally to mask an ingest-consumer wakeup problem.

## Boat: concrete collection choices

All four paths below must produce the same normalized usage projection, not
raw public `other` events containing transcripts or account metadata. None is
implemented by this PR. Current upstream documentation is a capability reference,
not proof that Boat's installed version or noninteractive mode exposes it.

| Boat path | Tokens and subscription readings | Reliability, cost and lifecycle trade-off |
| --- | --- | --- |
| **Harness hooks/notify → local spool → Armada exec read** | A hook is a trigger, not necessarily a token payload. Claude Stop can identify a transcript/session; Codex notify receives JSON but is not promised to include usage or run in Boat's app-server mode. A small extractor must supply numeric usage from a validated native source. Spool may include account windows only when the harness actually supplies structured limits. | No daemon and no guest network credential. Hook helper exits after atomic, bounded writes. Server reads on terminal observation and **before** stop. Fast enough for end-of-turn cost, not live metering; missed hooks, premature transcript flush, hard kills and config overrides cause gaps. Preserve/chains user hooks only with an explicit supported mechanism; never overwrite them silently. |
| **Read the harness's own local session/usage files over exec** | Extract Claude assistant usage/model records and Codex rollout token-count/model records **if verified on the actual Boat versions**. Use final/cumulative semantics appropriate to that version, not a blind sum. Can recover persisted records after a missing hook. Limits only if an explicit, timestamped native limit snapshot is present; ordinary token history cannot reconstruct a subscription percentage. | Smallest initial source: no process installation or harness replacement; bounded reads after a turn and before stop. Internal file formats, session mapping, truncation and disk retention are fragile; pin parsers, reject unknown shapes. Guest-local parsing prevents transcript export. No guarantee for unflushed/lost records or deleted sandboxes; reads before stop cannot run after forced expiry. |
| **Run Armada's runtime on Boat as on Modal** | Direct Claude SDK result/usage and Codex app-server usage/account notifications, as in managed drivers; explicit account reads can improve quota coverage without inference where supported. | Most control, but **not** a drop-in reporter. Must move prompt/send/steer/interrupt/events/session ownership from Boat's launcher to Armada, install/pin tools, secure RPC/ingest, hydrate auth, supervise processes and prove stop/resume compatibility. Never run both supervisors against the same native session. More rollout cost and a separate provider-adapter project; not the first slice. |
| **Ask Boat upstream to expose usage in events** | Prefer raw structured final token counters/model and separately authorized subscription snapshots tied to native session/turn identity; Armada normalizes and filters. | Cleanest long-term provider contract, no new guest writer/credential or golden rebuild. Upstream delivery/version/retention and privacy semantics are external dependencies. File the request, but **do not block** the local first slice on it or pretend current events already contain usage. |

### Smallest useful Boat implementation: bounded local extraction, hooks optional

Implement a server-triggered, one-shot **guest-local usage extractor over the
existing Boat exec primitive**, first for both native harnesses in #874's capture
work. No daemon, new model process, prompt, or guest callback token is needed.
Hooks/notify can later mark the exact session/turn and populate a sanitized spool;
they are an optimization once proven in Boat's actual invocation mode, not a
prerequisite assumed to work. The current Codex cwd bridge in
`packages/provider-boat/src/native-cwd.ts` already observes app-server protocol;
if session mapping or account notifications are absent from files, a narrowly
scoped tee of usage/identity notifications there is a smaller candidate than
replacing the runtime. That tee also needs independent privacy/lifecycle review.

Implementation sequence and acceptance boundary:

1. Before admitting a turn, establish the native session identity and a persisted
   baseline/offset for this sandbox/conversation/incarnation. Bind it to Armada's
   prompt ID. Locate only that session beneath fixed harness-owned roots, with
   symlink/path/type/size checks; never scan every user's transcript or trust a
   model-supplied pathname. Inventory numeric shapes and whether native subagent
   sessions are included using real Boat samples from both harnesses. If identity
   cannot be established, mark usage unavailable rather than attribute the newest
   file to whichever turn just finished. A proven identity hook/bridge is then
   part of the minimum implementation, not optional guesswork.
2. On finished/failed/interrupted observation, execute a fixed extractor, not
   `cat` or user-controlled shell. Parse locally and emit only bounded numeric
   counters, model, opaque native record/turn IDs, provenance and completeness.
   Handle duplicate Claude content-block/message snapshots and Codex cumulative
   totals/resets explicitly. Preserve cache read/write and reasoning fields only
   when reported; avoid counting reasoning twice in output. Unknown model or
   baseline stays null. Do not assign lifetime session totals to a new turn.
3. Retry boundedly after terminal observation to accommodate delayed file flush;
   persist offsets and idempotent native-record keys only after server commit.
   Reconcile on the next turn/status read and **before stop dispatch**. Collect
   what is persisted before interruption, then final persisted data after the
   harness quiesces where supported and before machine termination. Record an
   incomplete reading on timeout and still allow an authorized stop; do not
   invent a final total or confuse optional accounting failure with a checkpoint
   success. Surviving spool/files may be reconciled after resume, with identity
   fencing; fresh forks must not inherit billable history or old baselines.
4. Feed #874's existing per-turn/per-sandbox projection and #875's pure cost
   computation. Annotate source/coverage so partial totals render **partial**, not
   a complete cost. Use measured normal/interrupted/multi-turn/resumed samples
   from both Boat harnesses to prove non-empty usage and no double counting before
   rollout. This design supplies no such local samples and does not claim an
   already-working Boat parser; implementation must produce them.

This yields post-turn **reported tokens**, with no new long-lived guest writer,
for turns whose records can be mapped and persisted. It cannot see provider-hidden
usage, records never flushed before kill, unassociated subagents, other sessions,
shared-account spending outside the sandbox, or an actual subscription invoice.
It cannot backfill deleted files or guarantee live token updates. An incomplete
sample is not an exact sandbox total. Use `estimated cost` for API keys and
`API-equivalent cost` for subscriptions, with unknown prices explicit (#875).

### Boat subscription limits: a separate, honest collection path

Do not claim the token extractor alone fixes #873:

- **Codex:** extract an explicit native limit snapshot from the admitted rollout
  only if the pinned version records it, retaining its own observation time.
  Otherwise capture `account/rateLimits/updated` and bounded
  `account/rateLimits/read` on the **existing** Boat-managed app-server channel
  through an approved bridge/upstream integration. Armada's managed driver already
  uses these methods (`packages/agent-runtime/src/codex.ts`); Boat public events
  currently do not deliver them in the supplied sample. Do not spawn a second
  app-server, read auth files, or infer account allowance from token_count.
- **Claude:** Stop metadata/transcript token counts do not establish a quota
  reading. Current [statusline documentation](https://code.claude.com/docs/en/statusline)
  describes structured five-hour/seven-day percentage/reset fields, but a
  statusline callback must be proven to run in Boat's headless mode before using
  it as a sanitized spool writer. Otherwise seek Boat's passthrough of native
  structured `usage_report`/supported usage-query results (existing handling in
  `packages/agent-runtime/src/claude.ts` and `packages/mcp-server/src/model-usage.ts`).
  No extra inference turn, raw `/usage` text scraping or undocumented OAuth call
  is authorized by this proposal. If none is available, explicitly report
  **no allowance reading available for this Boat account**, not a fabricated bar.
- Normalize only windows/used percentage/reset/observed time against the
  server-pinned account/revision, under the existing account visibility policy;
  API-key accounts show **not a subscription**. A guest may forge its own sample,
  not choose the account it updates. Stale account readings retain original time.
  A sandbox collaborator must not gain account-private windows through its public
  events or exec logs. Keep raw transcripts and account payloads inside the guest;
  the internal exec collector needs a private, bounded output path bypassing
  ordinary owner-visible command/event journaling for account readings. If Boat's
  exec cannot guarantee that boundary, do not use it for quota: use a reviewed
  private channel/upstream integration or leave quota unavailable.

Primary references: [Claude hook inputs](https://code.claude.com/docs/en/hooks)
provide session/transcript metadata, not a universal token/limit payload;
[Codex notify configuration](https://developers.openai.com/codex/config-reference/)
provides a notification command, not an accounting guarantee;
[Codex app-server](https://developers.openai.com/codex/app-server/)
is the structured account/turn integration surface. All require validation against
Boat's actual installed version and launch mode; Modal's pinned dependencies are
not evidence of Boat's file schema or hook invocation.

## Proposed trust, delivery and lifecycle contract

This is a future implementation contract, not an endpoint shipped by this PR:

1. Versioned envelope: server-bound sandbox/incarnation identity, monotonic
   sequence, report kind, observation time and bounded typed fields. Server adds
   receipt time and resolves tenant/visibility/account binding from trusted state,
   never guest JSON. Dedup key includes incarnation and sequence; reject conflicting
   retransmissions. Acknowledge only after durable persistence.
2. For push reporters, bootstrap a short-lived report-only capability over the existing private
   control path. Rotate/revoke on expiry, stop, deletion and incarnation change;
   no credential or callback authority in golden files, argv or logs. Fix the
   server destination at bootstrap, require HTTPS and disallow redirects.
3. Wake existing state consumers after durable ingest. Validate admitted turn
   identity and legal transitions; late/reordered reports cannot reopen terminal
   turns. Reconcile against canonical provider state; contradictions produce
   unknown/conflict, not automatic lifecycle mutations. No automatic stops,
   pushes, repairs or orchestration actions from telemetry.
4. Bound queue bytes, batch bytes/count and retention. Retry without blocking
   harness execution during transient outages; explicitly surface missing ranges
   and stale readings. Account usage stays account-authorized even if sandbox
   collaborators can read ordinary reports. Proposed default: latest-only
   periodic metrics, seven-day normalized turn-report retention, no duplicate raw
   transcripts; confirm policy/capacity before implementation.
5. Modal checkpoint: seal admissions and timers, stop collectors/hooks and harness
   descendants, drain to an exact durable ACK watermark, scrub transient authority,
   then prove process quiescence before snapshot/termination. Follow
   `packages/agent-runtime/src/runtime.ts`, `packages/provider-modal/src/process-scope.ts`,
   `ssh.ts`, `snapshot.ts` and `provider.ts`; never exempt arbitrary writers or
   weaken fail-closed scrub to accommodate a reporter. #732 specifically includes
   launcher, app-server, MCP descendants and golden services. Optional metric
   failure must not invent successful checkpoint ACKs; unacknowledged terminal
   records keep the existing checkpoint failure semantics.
6. Recovery retains only allowed durable reports/sequence state, never usable
   tokens. Fresh forks discard source report history; resumed incarnations get
   new grants and a deliberate replay/mapping policy so old accepted records are
   not double-counted or admitted under new identity. Boat stop/resume must
   similarly re-bootstrap and fence the old collector; no promise of a last
   heartbeat on forced expiry. Verify stop/resume/stop and abrupt death on each
   placement before rollout. No migration or production exercise in this ticket.

## Recommendation and follow-up issues

**Boat usage first: bounded exec extraction of native session usage, supplemented
by a proven identity hook/bridge when necessary.** Deliver real per-sandbox
reported tokens for both Boat harnesses under #874 before prioritizing faster
Modal lifecycle reporting. Run the collector at turn end and before stop, and
surface partial/unavailable honestly. Pair this with a separate #873 quota source
validation; tokens alone are not subscription limits. No daemon and no implicit
replacement of Boat's native harness are needed for this first slice.

Retain provider lifecycle polling and pursue Boat upstream passthrough in parallel,
without waiting for it. Extend Modal's existing runtime report contract after the
Boat accounting slice; its existing usage source is already demonstrated. Only
consider running Armada's full runtime on Boat if local extraction/bridge and
upstream integration cannot meet the required fidelity, with a separate decision
covering full harness ownership and compatibility. Quality before breadth: do not
ship a guessed file attribution or show an invented quota to claim parity.

**Never report** file contents, diffs, filenames, prompts, model replies, tool
inputs/results, transcripts, environment values, secrets/auth caches, tokens,
credential-bearing URLs, raw native/hook payloads, arbitrary logs or process
command lines. Existing conversation transport is separate and is not permission
to copy those fields into telemetry. Keep diagnostics to closed categories.

Follow-up issues (created for this design; links below):

1. [feat(usage): collect Boat native session tokens without a daemon](https://github.com/The-Vibe-Company/armada/issues/883).
2. [feat(usage): establish Boat account-private subscription limit sources](https://github.com/The-Vibe-Company/armada/issues/884).
3. [feat(provider-boat): request structured upstream usage passthrough](https://github.com/The-Vibe-Company/armada/issues/885).
4. [feat(runtime): normalize Modal reports with checkpoint-safe durable delivery](https://github.com/The-Vibe-Company/armada/issues/886).
5. [feat(reporter): add bounded operational observations after accounting](https://github.com/The-Vibe-Company/armada/issues/887).
