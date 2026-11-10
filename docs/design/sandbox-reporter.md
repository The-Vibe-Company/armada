# Sandbox reporter: reuse the runtime, not another daemon

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

Thus #873–#875 should reuse existing accounting inputs, not create a second
billing ledger. Likewise #846/#847 motivate faster observation, not another
independent source of terminal truth. A push only improves latency if the server
consumer wakes on durable ingest rather than waiting for its next poll.

## What is worth reporting

Priority ranks incremental value, not permission to expose everything already
available in a native event stream. Every reading needs source, observation time,
server receive time, freshness and an explicit unavailable/unsupported state.

| Rank | Report | Boundary / caveat |
| --- | --- | --- |
| 1 | Turn started/finished/failed/interrupted, harness reason code, turn/model identity | Link to admitted prompt/conversation; preserve native reason as a closed code, not arbitrary stderr. Guest terminal claims do not prove machine stop. |
| 2 | Per-turn input/output/cache tokens, observed model and usage provenance | Separate requested from observed model. Preserve unknown/reset/partial counters; deduplicate deltas. Cost is a server-derived estimate with price/version, never an invoice or subscription charge. |
| 3 | Subscription windows, reset times and limit status | Account-private, pinned credential identity/revision; not an org-visible sandbox message. No account identifiers or raw native payloads in the common report. Never manufacture a Claude limit by scraping rendered text. |
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

### A. Extend the runtime/Runner with common structured reports (preferred)

On Modal, reuse supervision, driver parsing, durable sequence/ACK mechanics and
checkpoint ownership. Add a separate allowlisted report lane, not raw `other`
events. On Boat, keep provider events as canonical turn input; a future small
collector can submit the same report contract for metadata absent from Boat.
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
  integration work and must demonstrate benefit over provider pulls first.
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
not a durable lifecycle protocol or a reason to scrape private transcript files.

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

## Proposed trust, delivery and lifecycle contract

This is a future implementation contract, not an endpoint shipped by this PR:

1. Versioned envelope: server-bound sandbox/incarnation identity, monotonic
   sequence, report kind, observation time and bounded typed fields. Server adds
   receipt time and resolves tenant/visibility/account binding from trusted state,
   never guest JSON. Dedup key includes incarnation and sequence; reject conflicting
   retransmissions. Acknowledge only after durable persistence.
2. Bootstrap a short-lived report-only capability over the existing private
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

**Choose A incrementally, retaining D. Do not install a new always-on daemon in
all goldens.** The smallest first step is an opt-in, normalized turn-lifecycle
report lane on the existing Modal Runner and a durable-ingest wakeup of the
existing consumer, with pull reconciliation and measured finish-to-observation
latency. Use existing harness terminal reasons; no new account scraping, git
scanner or heartbeat loop in that first slice. Validate checkpoint safety before
expanding coverage. Boat parity means the same *contract*, not pretending it runs
the same resident runtime today. Golden installation remains allowed if a later
Boat experiment shows it is the smallest reliable solution.

**Never report** file contents, diffs, filenames, prompts, model replies, tool
inputs/results, transcripts, environment values, secrets/auth caches, tokens,
credential-bearing URLs, raw native/hook payloads, arbitrary logs or process
command lines. Existing conversation transport is separate and is not permission
to copy those fields into telemetry. Keep diagnostics to closed categories.

Proposed follow-up issue list (five; not created by this design PR):

1. **Report contract and Modal lifecycle pilot:** typed allowlisted envelope,
   report-only grants, durable ACK/dedup, consumer wakeup and fallback; prove
   forged scope/replay rejection, outage recovery and checkpoint stop/resume/stop.
   Measure p50/p95 observation latency against current polling (#846/#847).
2. **Unify usage projections, not ledgers:** reuse #873/#874/#875 native inputs;
   normalize per-turn tokens/model with unknown/reset semantics and account-private
   subscription readings; server-side price provenance, freshness and retention.
3. **Boat reporting feasibility/parity:** audit real provider event coverage and
   latency; choose provider-only normalization or a minimally supervised collector.
   Prove credential rotation, forced expiry and resume without requiring a fleet
   of golden rebuilds; do not replace the native harness launch path implicitly.
4. **Safe operational observations:** bounded git summary (#747), versions,
   bootstrap skill receipts, ready timing, sparse liveness and resource sampling;
   provider-authoritative expiry (#851), permissions and explicit stale states.
5. **Portable reporter lifecycle conformance:** reusable Docker/Kubernetes-ready
   identity/transport seams, queue bounds and failure-injection suite spanning
   forks, stop/resume/checkpoint, MCP/hook descendants and golden background
   services (#732). Gate any separate-daemon proposal on this evidence.
