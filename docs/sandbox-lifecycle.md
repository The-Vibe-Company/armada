# Sandbox lifecycle and transition design

Design for [#2787](https://github.com/The-Vibe-Company/armada/issues/2787), after native retirement (#2743–#2748) and synchronous lifecycle removal (#2765). The [implemented model](state-model.md) describes current behavior. The [machine contract](machine-contract.md) defines provider operations, runner claims and durable dispatch phases.

## Why status needs one owner

The journal trigger in `20261118120043_sandbox_transitions.sql` fires only when an update supplies `transition_context`. For example, `runtime-progress.ts` writes `failed` without that context. Both journaled and unjournaled writes can succeed. Separately, `turns.ts` can move a sandbox from `running` to `ready` when its turn settles even though the same machine is still available. Centralize machine state changes in one transaction and keep turn activity independent.

## State and activity

| Machine state | Meaning |
| --- | --- |
| `starting` | A launch or resume intent owns this generation. The runtime has yet to enrol. |
| `running` | The current runtime enrolled and the machine is available for turns, subject to authorization and admission policy. |
| `stopping` | Durable stop intent fences activity. Physical exit or requested retention still needs confirmation. |
| `stopped` | Physical exit is confirmed. Resume requires a verified retained reference. |
| `failed` | A machine operation definitively failed. A row may still own compute until cleanup confirms exit. Preserve the failure code and unresolved resource references. |
| `deleted` | Exact-generation compute and the resources covered by deletion are confirmed absent. The logical tombstone is terminal. |

The public `activity` uses durable turn evidence scoped to the sandbox and current generation. An accepted pending turn is `queued`. Dispatching, uncertain dispatch and an admitted active turn are `working` until resolved by their stable turn/command ID. Explicit runtime evidence of a blocked turn is `waiting_input` until input is accepted or the turn settles. With no unsettled turn or pending intent, activity is `idle`. While a machine starts, a queued initial or wake turn can already be visible. If an active turn and a queued intent coexist, show the active turn's activity first. A completed, interrupted or failed turn retains its own outcome and cannot fail a machine on its own. Stop settles or fences turns independently of physical exit. Idle detection uses durable turn evidence and checks for queued or uncertain work before requesting stop.

Only the sandbox lifecycle module can change machine state. Each operation carries `(sandboxId, generation)` and the existing runner owns one lifecycle lease and one absolute deadline per sandbox. The runner or the successor of its expired claim can hold that lease. Admission, owner cancellation and runtime enrolment serialize on the sandbox row without taking it. Adapters and daemon callbacks supply receipts. Inventory, outputs, webhooks, scans and exports hold no sandbox lease.

## Allowed transitions

Every row is executed by the sandbox lifecycle module. The actor names the authorized producer within that module. The code records a stable reason such as `launch_admitted`, `runtime_enrolled`, `idle_paused` or `retention_elapsed`. The module rechecks authority and evidence inside the transaction. Effects in the table are logical jobs or transactional handoffs to existing job intents. Their handler tickets own registration.

| From → to | Actor and required trigger | Atomic job or handoff |
| --- | --- | --- |
| Absent → `starting` | Launch admission validates caller, inputs and idempotency key and initializes the generation. | Insert sandbox, launch job and receipt. Register the initial turn intent if supplied. |
| `stopped` → `starting` | Resume admission validates the retained predecessor, lifetime and access. A wake request uses the same admission path. | Advance generation once, clear prior stop markers, and enqueue resume with the pinned predecessor reference. Bind an accepted wake turn and its stable ID to the new generation in the same transaction. Replay returns the same intent. |
| `starting` → `running` | Authenticated runtime enrolment matches the current dispatched intent and physical binding. Cancellation, expiry or revocation fences publication. | Commit binding and make any durable initial or wake turn dispatch eligible. Deduplicate dispatch on its stable turn ID. The runner completes launch or resume against this binding. |
| `starting` or `running` → `stopping` | Owner stop/delete, finish, expiry or idle policy records stop intent and cancels conflicting dispatch. If startup is in flight, reconcile its result before issuing stop. | Enqueue or hand off to the same-generation stop intent. Refuse undispatched work under the row lock. |
| `starting` or `running` → `failed` | Lifecycle runner records a proven startup failure or verified loss of a running machine. An expired startup can fail logically while the allocation outcome remains unknown. | Fence enrolment and turns. Keep unresolved ownership and hand it to existing reconciliation. |
| `stopping` → `stopped` | Runner confirms exit and verifies retention if requested. | Commit the retained reference and exit evidence. Enqueue applicable output publication and `sandbox.stopped` or `sandbox.expired` webhook. |
| `stopping` → `failed` | Runner proves a terminal stop failure, such as physical exit without required retention. An unknown exit remains `stopping`. | Preserve evidence and retain any cleanup intent. |
| `stopped` or `failed` → `deleted` | Authorized delete or retention job confirms destruction or authoritative absence for the exact generation and required resources. A failed row must settle unresolved compute first. | Commit tombstone and enqueue applicable `sandbox.reclaimed` webhook and metadata/archive retirement. |

A terminal delete request records a job before external dispatch and stays in the source state until proof arrives. Serialize deletion against resume and block replacement while deletion remains unresolved. After failure, cleanup may record verified exit and clear pending ownership while preserving `failed` and its diagnostic. That is a generation-fenced metadata update. Provider readiness, host ACKs, finished jobs, MCP setup and access handlers cannot promote a machine. A retained `stopped` sandbox must pass through `starting` and enrol again. Output staging may be a bounded best-effort step inside stop preparation per the machine contract. Publication, retained reads, exports, webhooks and scans run independently and never gate state or a receipt.

## Database contract for #2788

`sandbox_transition(id, expected_generation, from_states[], to_state, actor, code, effects jsonb)` is an internal, service-only, typed transaction boundary. The lifecycle wrapper supplies a trusted actor, allowed source states and validated effect descriptors. Restrict execution to the lifecycle service role and validate edge/actor combinations, safe codes and allowlisted job kinds. Never pass a client-supplied actor or arbitrary job payload through. SQL bypasses RLS, so the caller must enforce visibility and preserve operation-specific fences such as lease ownership, cancellation, runtime binding and authorization in the same locked transaction.

1. Lock the sandbox row and compare actual status with the allowed source set and actual generation with `expected_generation`. Return typed conflict on a missing row or mismatch, with no journal, effects or event. Re-read before deciding whether the intent already succeeded, should be abandoned or can be retried. Reject disallowed and same-state edges.
2. Update status and its coupled evidence atomically. Resume bumps the generation in this step. Launch initializes the generation in the admission transaction, and stop, failure and delete retain it. Use typed lifecycle inputs or guarded updates in the same transaction for coupled fields such as stop timestamps and physical identity. Do not support arbitrary patch JSON.
3. Append exactly one `sandbox_transitions` row per successful status update with actual old/new values and the resulting generation. Use a single journal path. While the opt-in trigger exists, the function can supply its validated context and let it produce the row. Avoid a second manual insert. Initial creation has no predecessor in the existing journal schema, so its durable admission evidence is the starting sandbox and job/receipt transaction. Keep initial inserts with the lifecycle owner.
4. Insert effect jobs using the resulting generation, organization and stable intent/effect identity, with deduplication on replay. Validate required deadlines and referenced payloads before committing. Effects needing older evidence carry its immutable reference and cannot update a replacement. Any write failure rolls back the whole transition.
5. #2788 leaves an event hook with no producer. #2796 appends a single `event_log` reference in the transition transaction and appends runtime references with event ingestion. Resolve authorization before exposing events. Store no decrypted runtime content in the feed.

For rollout, #2788 uses the current persisted enum. It can journal old `ready` and `running` edges while writers move in #2789–#2792. #2793 adds the target database projection without changing the old column or enum in place. During the deploy overlap, legacy `status` remains the storage authority and old binaries keep their predicates and transitions. New readers use the additive projection over the same rows and evidence so both revisions observe each other's committed updates. Project legacy `ready` and `running` as machine `running` only with a current runtime binding proving availability. Gate activation of the new read model on resolving existing ambiguous rows through lifecycle reconciliation. After activation, a read that loses proof of the current binding returns a typed unavailable response until reconciliation commits a valid state. Derive activity from durable queue and runtime evidence.

After the last old database reader/writer has drained, switch the transition function to target state and remove obsolete status access in a later deploy. Use a distinct target state type and preserve the original journal enum values and historical rows, including old `ready` ↔ `running` activity edges. New machine journal rows record only real machine edges. Recheck SQL consumers, triggers and predicates, including metering, authorization, turn wakeups and webhooks.

## Crash recovery and provider paths

The durable phase table in the [machine contract](machine-contract.md#lifecycle-states-and-crash-recovery) applies to each provider below. All subsequent awaits within a phase follow the same rule until another durable checkpoint is committed.

| Durable checkpoint | Next await and recovery owner |
| --- | --- |
| Admission or cancellation with queued work | A crash before reply, scan, wake or claim leaves a durable receipt/intent. Replay returns the same receipt and the existing lane finds the job. |
| Lease claim or takeover | Before any authorization read, observation or dispatch-intent write, the runner successor can recover the same job, phase and deadline. Lease loss fences completion. |
| Create, bootstrap, resume, checkpoint, stop or delete intent | If the provider call or receipt persistence is interrupted, the runner reconciles the exact generation and either adopts the receipt/result or repeats the same key where safe. Missing host, app or image alone is unknown. Checkpoint intent and retained-reference persistence each precede source destruction. |
| Physical identity or other operation receipt | Before the next intent, evidence check or transition, the successor resumes from the receipt. Bootstrap success still waits for valid enrolment. Stop and delete retry observation after loss of an acknowledgement. |
| Enrolment with state and turn eligibility | Before the enrolment response, job completion, wake or turn dispatch, the runner can recover the binding and the turn lane can replay the durable intent using its stable turn ID. Serialize cancellation against enrolment and dispatch eligibility. |
| Retry, terminal state, effect enqueue or effect checkpoint | A missed response/wake is recovered by the existing lane. Each effect owns its own deadline and durable identity. Reconcile uncertain delivery before repeating it where supported. A stale completion cannot write over a newer generation. |

| Provider | Create, bootstrap and resume | Stop and delete | Paths removed |
| --- | --- | --- | --- |
| Boat | Shared jobs, Armada runtime enrolment, verified retained VM on resume. | Verify disk retention when requested and exact physical exit or deletion. Boat evidence is coordinator-only. | Native CWD/MCP/events and prompt via #2745–#2748. Synchronous lifecycle via #2765. |
| Modal | Shared jobs, Armada runtime enrolment, restore exact recovery image. | Persist verified recovery image before terminating retained compute, then confirm exact deletion scope. | Native runner/tunnel/admission via #2743–#2744 and #2747–#2748. Synchronous lifecycle via #2765. |
| Docker | Shared jobs over outbound daemon, Armada runtime enrolment, verified same-host workspace restore. | Confirm exact-generation daemon receipts. Offline host leaves an unknown result. | Separate normal-launch/send workers and old controls via #2765. Daemon job transport remains. |

## Current writer inventory

Audit baseline `4d8581ae0f5f187e73cacd071f401d9340c6b856`. Includes direct SQL, dynamic insert/update helpers and callers that choose the status. The destination column assigns surviving behavior to 3-03 through 3-06. A deletion entry describes the earlier ticket removing the path. Paths in the server rows are relative to `packages/mcp-server/src`.

| Current file | Status decision or write | Deletion or destination |
| --- | --- | --- |
| `packages/core/src/sandbox.ts` | Store insert with input status and dynamic patch of status. | #2789 for initial launch ownership, #2792 for shared store writes after callers migrate. |
| `packages/core/src/launch.ts` | Insert starting; mark ready, running or failed across runtime/native launch paths. | #2747 removes native admission branches, #2765 removes remaining synchronous path, #2789 owns job admission. |
| `data.ts` | Visible sandbox insert and dynamically generated status patches for lifecycle/turn callers. | #2789 for launch admission, #2792 removes direct generic status mutation. |
| `docker-sandbox-service.ts` | Insert Docker sandbox with starting state. | #2761 cuts admission to jobs, #2765 removes obsolete admission, #2789 owns the job's starting write. |
| `docker-normal-launch.ts` | Starting → ready from legacy launch completion or failed on launch error. | #2765 deletes worker, #2789 owns launch job failure and #2791 owns enrolment. |
| `sandbox-access-child-launch.ts` | Child launch delegates to legacy core launch/store and wraps its insert. | #2765 removes legacy path, #2789 owns surviving launch admission. |
| `tools.ts` | Native send/status refresh and legacy stop/resume select status via activity/store patches. | #2744/#2747/#2748 remove native dispatch; #2763/#2764 move stop/resume, #2765 deletes obsolete controls; #2790 and #2791 own surviving lifecycle and turn behavior respectively. |
| `sandbox-lifecycle.ts` | Reconciliation publishes stop or failure and closes interrupted startup/resume. | #2790. Launch-job-specific failure goes to #2789. |
| `sandbox-finish.ts` | Finished sandbox reserves stopping and dispatches cleanup. | #2790. |
| `sandbox-extend.ts` | Provider extension racing expiry can publish stopping through a store patch. | #2790. |
| `sandbox-rest-controls.ts` | Provider deletion completion supplies deleted via activity patch. | #2790. |
| `runtime-resume.ts` | Claims starting on resume; chooses running, failed or stopping from the outcome. | #2764 moves resume to jobs and #2765 deletes old paths, #2790 owns surviving resume transitions, #2791 owns enrolment/turn activity. |
| `runtime-followup.ts` | Running patches on follow-up admission; retained wake delegates to resume. | #2791 for activity, #2764 and #2790 for resume. |
| `turns.ts` | Status reconciliation on turn settlement via store update, used on native and runtime paths. | #2744/#2746–#2748 remove native producers; #2791 removes turn-driven machine status. |
| `runtime-idle.ts` | Runtime idle policy sets stopping. | #2791 migrates the writer, #2805 moves detection to jobs. |
| `runtime-progress.ts` | Bootstrap/progress failure sets failed with direct SQL. | #2791 validates and hands evidence to lifecycle owner. |
| `docker-bootstrap-service.ts` | Docker resume marks starting directly. | #2764/#2765 remove old control path, #2792 removes any surviving direct assignment and hands resume to #2790. |
| `docker-host-store.ts` | Host create/launch failure, stop intent and receipt, expiry, retention loss and deletion. | #2792 removes direct assignments. Adapter reports receipts to #2789/#2790 as applicable. |
| `docker-runtime-lifecycle.ts` | Enrolment/startup sets ready and dispatch sets running. | #2792 removes adapter writes, #2791 owns shared enrolment and activity. |
| `mcp-lifecycle.ts` | MCP boot promotes stopped/starting to ready on provider evidence. | #2792 removes promotion. Native pieces retire under #2747/#2748, readiness moves to #2791. |
| `sandbox-armada-access.ts` | Access boot observation promotes a stopped sandbox to ready. | #2792 removes promotion; the job and enrolment path owns wake. |
| Authenticated direct SQL via `20261108190000_revoke_default_grants.sql`, `20261108170000_sandbox_status_reason.sql` and `20261110121100_sandbox_access.sql` | Column grants and owner/org-admin UPDATE policy allow status and coupled timestamps/reason updates on applicable rows. | #2792 audits callers and moves status control to the lifecycle service. #2795 revokes direct lifecycle column writes while retaining permitted metadata access. |
| `sandbox-access-services.ts` | Delegated send and stop use activity patches for running/stopping/stopped. | #2792 moves access calls to shared operations. #2748 removes native prompt/stop integration, with #2790/#2791 owning remaining outcomes. |

Adjacent files matter even where they only write metadata or invoke a writer. The split below records their review ownership without counting them as direct status assignments.

| Current files or paths | Relationship | Destination |
| --- | --- | --- |
| `packages/core/src/sandbox-activity.ts` and server `sandbox-activity.ts` re-export | Applies caller status patches at admission, completion and failure, and can advance generation for activity. | #2765 removes legacy synchronous uses. #2790 moves lifecycle admission to the shared operation, #2791 removes machine-generation changes from turn admission, and #2792 removes generic status writes. |
| `credential-binding-recovery.ts`, `sandbox-account-change.ts` | Credential binding metadata; account changes can request a stop through lifecycle. | #2765 deletes the separate recovery loop; #2789 preserves launch binding and #2790 owns the stop. |
| `work-preservation.ts`, `runtime-checkpoint.ts`, `output-transfers.ts`, `sandbox-outputs.ts`, `retention-maintenance.ts` | Retention/capture data and scheduled retirement use lifecycle state. Stop/delete through their owner. | #2790 audits lifecycle interactions, #2803 owns output jobs. |
| `runtime-enrolment.ts` | Checks eligibility and stores runtime auth/binding. This is the target publication boundary. | #2791. |
| `resource-store.ts`, `sandbox-pull-requests.ts`, `packages/core/src/connections.ts`, `packages/core/src/delegated-authority.ts` | Sandbox metadata or authorization, with status predicates where applicable. | #2792 audits the boundary; leave metadata mutations scoped to their owners. |
| `native-idle.ts`, `native-webhook-prompts.ts`, `modal-integration.ts`, `modal-event-usage.ts`, `subscription-boat.ts`, `packages/core/src/launch-native.ts` | Native turn/idle evidence, event/usage ingestion or launch preparation. They feed existing lifecycle decisions and do not own independent status SQL. | #2744, #2746 and #2747 delete these paths. #2743/#2745 remove provider-side native support and #2748 removes the selector and native operations. #2789–#2791 own remaining launch, stop and turn paths. |
| `docker-queued-prompts.ts`, `docker-prompt-worker.ts`, `docker-sandbox-controls.ts` | Queue/worker status belongs to prompts; legacy Docker controls hand off physical lifecycle to Docker services. | #2765 removes obsolete workers and controls. #2790–#2792 own surviving behavior and receipts. |

Repeat the audit on the cutover baseline. Search SQL `INSERT` and `UPDATE` on `sandboxes`, including computed assignments and CTEs. Follow typed patches through store/activity adapters and check SQL triggers and JWT writes. Exclude projections, predicates, status on other tables, and test fixture setup from the production writer count. Confirm that new Step 2a launch jobs (#2760–#2762) map to #2789 and stop/resume jobs (#2763–#2764) map to #2790.

## Enforcement and clients

Deploy the additive function first. Move or delete all writers with #2789–#2792. After those last writer removals are deployed and the overlap has elapsed, ship #2795 in a later deploy. Reject direct status changes at the database and remove writer exceptions. Bind enforcement to the privileged transition path. A caller setting `transition_context` by itself must be insufficient. Verify authenticated and service callers cannot bypass the path, including attempts to change lifecycle timestamps or forge a context. Reject arbitrary initial inserts that bypass owned admission, while preserving metadata-only updates. Verify the rejection and one journal row per accepted edge, and reconcile the one-writer metric with the SQL implementation and its lifecycle wrapper.

#2793 prepares the schema and server read model. #2794 prepares dashboard queries under RLS and rendering, CLI list/info/filter/wait behavior, generated SDK types and hand-written iOS models. Coordinate the ticket split before either removes the public field. Land the breaking replacement and all in-repo caller changes together, updating the common contract, OpenAPI, REST/MCP responses, outbound webhook payloads, Armada skill, coordinator commands and smoke scripts in the same cutover. Preserve event and delivery identities. Only the database schema overlaps during deployment. A readiness wait observes `state=running`. Turn settlement and stop-if-idle use activity and turn evidence. #2796–#2799 deliver event references and subscriptions separately.

The webhook's existing `state` field contains combined status values. Replace those values and add `activity` at the same contract boundary. #2793 and #2801 coordinate the webhook payload and producer handoff. Preserve current event names and the endpoint delivery identity across retries. Until transition jobs can share a stable transition-and-endpoint deduplication key with the existing trigger, use a single producer for each event. Once that key is shared, the database overlap can accept both producers into one delivery record. Keep task-report events on their own event identity. #2811 removes the old trigger/storage after its last code use has deployed.

Account for pending deliveries before exposing the new contract. Drain attempted deliveries under the existing sender and retry policy. At the producer cutover, translate remaining unsent payloads from durable evidence in the database, retaining their IDs, type and timestamp, before allowing the new sender to claim them. Serialize that boundary with claim and enqueue so no row is sent in both shapes or lost. If a pending payload cannot be translated faithfully, drain it before cutover.

This ticket is documentation only. Implementation, schema and protocol changes, provider checks, event delivery and client changes belong to the linked tickets.
