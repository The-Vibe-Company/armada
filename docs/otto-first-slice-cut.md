# Otto first web slice: delivery cut

Planning-only delivery for #1815. No application code or migrations are included.

Owner addition: one conversation can feed several objectives; Otto owns routing, numbered replies and mid-turn message delivery. Standing instructions given in passing are visible, editable, versioned first-class records, not invisible memory or authorization. Two additional slices (#1835/#1836) follow the first wave; total 17, explicitly authorized by the owner after the initial 15-ticket cut.
The owner’s adaptive-interview, five-minute start and web-first decisions supersede older proposals. #1816 owns the repository-rule rewrite; this cut does not change AGENTS.md.

## First parallel wave

#1818–#1821 can start immediately with no blocking dependency: objective threads, engine preflight, multi-repository observation, and evidence inspection. They own separate routes/modules; #1820 alone changes the existing observation surface. No shared schema migration file is preallocated: authors coordinate unique versions per the migration checklist.

## Dependency graph (arrow means blocks)

```text
START -> #1818
START -> #1819
START -> #1820
START -> #1821
#1818, #1819 -> #1822
#1818, #1822 -> #1835
#1835 -> #1836
#1822, #1835, #1836 -> #1823
#1823 -> #1824
#1823 -> #1825
#1824, #1825 -> #1826
#1826 -> #1827
#1820, #1825, #1827 -> #1828
#1821, #1828 -> #1829
#1821, #1824, #1828 -> #1830
#1829, #1830 -> #1831
#1831 -> #1832
```

## Three riskiest technical unknowns

1. **Safe effects across ambiguous failures.** `otto/api.ts` rejects writes and `otto/runtime.ts` only observes; existing facts are append-only observations, not an outbox. GitHub issue creation, provider launch and DB commit are not one transaction. Verify dedupe/correlation and fail-closed recovery for an accepted effect with a lost response before permitting automatic retry (#1822/#1826). “Sent” cannot stand in for acknowledged delivery.
2. **Multi-repository authorization and token separation.** `createOttoRuntime` currently binds one environment org/repository and one read-only observer token. `serve.ts` uses existing launch/GitHub credential plumbing that must not inject a GitHub token into Otto itself. Prove both dogfood repositories can be observed and written through correctly scoped server identities without weakening private visibility or reusing the observer token as a write credential (#1819/#1820/#1822/#1826).
3. **Proof sufficient for completion.** `read-model.ts` infers issue links from branch names and explicitly never completes tasks; `work-evidence.ts` supplies exact-head failure/queue evidence, not objective-level success or target-environment verification. Establish criterion/brief/head/target bindings and retain unknown for partial or missing observations; merging alone cannot verify a UI/service (#1821/#1830/#1831).

## Validation and rollout boundaries

Each ticket uses cheap deterministic targeted unit checks; actual screens and lifecycle are checked through the product in authorized staging. No provider/network/browser check is added to PR CI and no new CI job is proposed. The final walkthrough covers both Armada and Skillpack, parallel objectives, restart recovery, one parked objective and proof-visible receipts. It is a future acceptance procedure, not evidence it has passed.

Deferred: mobile/push, independent verifier agents, a general permanent-rules engine, sub-Ottos, Linear and monetary/time-budget enforcement. First-slice budget is attempt count; duration is observed reporting only. Cancellation stops future/running work through recorded intents; it does not pretend to undo merged code or production changes.

## 1. #1818 — otto: create and reopen an objective thread

Parent: #1815

## What the user can do
Create a request for one connected repository and return to its durable web thread.

## Acceptance (check by using the product)
- [ ] Create two objectives in the web UI; refresh and reopen each to find its own request and messages.
- [ ] Switch organization or sign in as an unauthorized user: neither objective nor its messages are exposed.

## Out of this ticket
Engine execution; interview generation; ticket planning; starting workers.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New core/src/otto/objectives.ts DTOs; mcp-server/src/otto/objectives.ts and objectives-api.ts; dashboard /otto/objectives routes, objective list/create components and lib/data/otto-objectives.ts. Own objective route shell; downstream tickets add imported child panels only.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
None; can start immediately.

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
New objective and thread-message tables with organization/repository/owner scope, revision and timestamps; explicit RLS/grants, bounded user-visible columns. Do not reuse replaceable otto_tasks. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 2. #1819 — otto: choose and preflight Otto’s engine without launching

Parent: #1815

## What the user can do
Choose a supported harness, model and model account for Otto and see missing access before spending an attempt.

## Acceptance (check by using the product)
- [ ] Open Otto engine settings and select a supported harness/model/account; reload and see the choice, without a launch.
- [ ] Choose an unavailable account or unsupported combination: see a connection link or precise capability error, never a credential value.

## Out of this ticket
Worker launch; automatic account switching; new harness/provider support; fixed Codex/Modal defaults.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New core/src/otto/engine.ts; mcp-server/src/otto/engine-preflight.ts and engine-api.ts; dashboard /otto/engine route and engine-picker component. Reuse existing catalogs/account/credential resolution without editing their policy.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
None; can start immediately.

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
New scoped engine-preference record holding account references only, with explicit RLS/grants; no ciphertext/token exposure. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 3. #1820 — otto: observe both connected dogfood repositories independently

Parent: #1815

## What the user can do
Select Armada or Skillpack in Otto observations and see evidence for that exact connected repository.

## Acceptance (check by using the product)
- [ ] Select each authorized connected repository and inspect its PR inventory; evidence and pagination stay inside that repository.
- [ ] Remove access or make a repository traversal partial: its view says unavailable/unknown while the other remains usable.

## Out of this ticket
GitHub writes; arbitrary repository discovery; changing private sandbox visibility; worker launch.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
Existing mcp-server/src/otto/runtime.ts, observation.ts, api.ts, snapshot.ts and serve.ts Otto observer wiring; existing dashboard observation page, lib/data/otto.ts and lib/otto.ts; docs/otto-staging.md observation setup. Do not edit new objective routes.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
None; can start immediately.

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
None expected: facts already carry org/repository; use existing authorized connected-repository records, not a new credential store. If an index is necessary, append an additive migration only. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 4. #1821 — otto: inspect exact-head mechanical evidence in the web

Parent: #1815

## What the user can do
Open a PR evidence page and distinguish observed checks/merge/deployment facts from unknown claims.

## Acceptance (check by using the product)
- [ ] Open a PR by repository and number: inspect observed head SHA, required checks, merge state and evidence links/times; a newer head invalidates old-head success.
- [ ] Deny policy/deployment read access or use incomplete observations: the page says unknown, not done or green.

## Out of this ticket
Objective completion; human approval; new deployment automation; agent verification.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New core/src/otto/proof.ts; mcp-server/src/otto/mechanical-proof.ts and proof-api.ts; dashboard /otto/evidence route. Reuse observation helpers read-only; #1820 owns observer edits.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
None; can start immediately.

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
None expected; derive from append-only observations. Any newly observed proof facts use the existing selected-metadata journal, never raw bodies. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 5. #1822 — otto: run a durable adaptive interview with the selected engine

Parent: #1815

## What the user can do
Ask Otto a task and answer numbered recommended questions in the objective thread, surviving an engine restart.

## Acceptance (check by using the product)
- [ ] Select the engine and start an interview: see a numbered frontier of decision questions with recommendations; Otto looks up facts instead of asking the owner.
- [ ] Answer a round or say “enough, go”; reopen after context loss and see settled decisions, sources, reversible assumptions and the remaining frontier, without a fixed question cap.
- [ ] Inspect the engine session/access: generic Skillpack grilling skills run unchanged, no GitHub token is delivered to Otto, and duplicate start requests do not create a second session.

## Out of this ticket
Ticket execution; 5-minute start timer; GitHub writes from the sandbox; editing Skillpack skills.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New core/src/otto/interview.ts; mcp-server/src/otto/interview.ts, engine-session.ts, intentions.ts and interview-tools.ts; dashboard interview-panel component. Own common intention journal/dispatcher interface and scoped Otto tool registration; no worker launch implementation.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
#1818, #1819

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
New durable decision/round state and intention/outcome journal with idempotency key, effect status and authorization scope. Record launch/message intent before effect; uncertain outcomes remain unknown and reconcile before retry. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 6. #1835 — otto: route a shared conversation across objectives

Parent: #1815

## What the user can do
Keep one web conversation while Otto routes interleaved requests and replies to existing objectives or opens a new one.

## Acceptance (check by using the product)
- [ ] In one web stream interleave an Armada bug, a Skillpack request and a numbered interview answer: Otto visibly links each message to the right objective/round or creates the new repository-bound objective without manual thread switching.
- [ ] Send short follow-ups mid-turn and retry a message: each is durably accepted once and delivered to the intended active or next turn; ambiguous routing asks a focused clarification rather than changing the wrong objective.
- [ ] Refresh and inspect the stream plus objective views: message links and pending delivery survive; unauthorized objectives remain inaccessible and a conversation never grants cross-org visibility.

## Out of this ticket
Cross-repository objectives; standing-instruction storage; mobile/dictation implementation; treating conversational approval as permission to bypass server policy.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New core/src/otto/conversations.ts; mcp-server/src/otto/conversations.ts, conversation-routing.ts and conversation-api.ts; dashboard /otto/conversations route and conversation-stream component. Own shared conversation/message-objective links and adapter into #1822 interview tools, not their decision reducer. #1818 objective threads remain filtered views. Minimal route/navigation integration only.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
#1818, #1822

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
Add shared conversations, ordered durable messages and scoped message-objective/round links; backfill existing objective messages additively without losing thread history. Revision/delivery keys prevent duplicate routing. Explicit membership/owner RLS/grants; links cannot expand visibility. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 7. #1836 — otto: capture and edit standing instructions from conversation

Parent: #1815

## What the user can do
Give an instruction in passing, see Otto retain it as a scoped standing instruction, and edit or revoke it from the web.

## Acceptance (check by using the product)
- [ ] Say “Codex only” or set a maximum-open-PR preference in the shared stream: see the extracted instruction, source message, scope and effective status in a visible editable list; ambiguous scope/conflicts ask for clarification rather than silently becoming authority.
- [ ] Edit or revoke the instruction, refresh, then start another objective: its brief/engine/dispatch preview shows the applicable current revision; already admitted work retains its recorded snapshot and contradictory choices are surfaced.
- [ ] Say “do not ask me about releases again”: retain it visibly, but show any unsupported effect or authorization requirement; standing instructions never mint access, auto-approve irreversible/production effects, override explicit server policy, or modify Skillpack skills.

## Out of this ticket
Executing releases/deployments/production actions; general policy language or rules engine; retroactive mutation of running attempts; invisible model memory; changing generic skills.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New core/src/otto/standing-instructions.ts; mcp-server/src/otto/standing-instructions.ts, instruction-tools.ts and instruction-context.ts; dashboard instruction-list/editor child of shared conversation route. Own extraction/store/edit/revocation and versioned context adapter. #1823 consumes adapter in briefs; #1826 consumes frozen effective context at launch; no ownership of their state machines.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
#1835

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
Add scoped versioned standing instructions with source message, author, effective/revoked state, precedence/conflict metadata and immutable objective/attempt context bindings. Explicit RLS/grants and bounded output; instructions are preferences/constraints, not credentials or permission grants. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 8. #1823 — otto: show a revisioned brief and persist the five-minute start decision

Parent: #1815

## What the user can do
Review the interview result, start now, cancel, or let the current brief become eligible after five minutes.

## Acceptance (check by using the product)
- [ ] Open the brief: see reformulation, size, expected proof, assumptions and missing-access checks; go starts eligibility immediately and cancel prevents it. Applicable standing instructions and their revisions are visible; unsupported/conflicting instructions are surfaced before start.
- [ ] Leave a brief unanswered for five minutes, including across server restart: exactly the current revision becomes eligible once; editing replaces its deadline and stale go requests cannot start it.
- [ ] Leave an irreversible choice or missing access unresolved: the objective parks rather than silently starting; reversible unanswered choices appear as assumptions.

## Out of this ticket
Worker dispatch; budget reservations; ticket graph implementation; model-authored server interview prose.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New core/src/otto/brief.ts; mcp-server/src/otto/brief.ts and brief-api.ts; dashboard brief-panel. Extend objective state through a dedicated repository module; #1822 owns intention implementation.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
#1822, #1835, #1836

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
Add brief revisions, eligible/start/cancel timestamps and revision-checked transitions; durable deadline, not a browser timer. Additive only. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 9. #1824 — otto: publish and inspect the internal ticket dependency graph

Parent: #1815

## What the user can do
See Otto’s small ordered vertical tickets and their blocking edges before any GitHub issue exists.

## Acceptance (check by using the product)
- [ ] Accept a brief and inspect tickets: each has a user outcome, 1–3 product-use criteria, expected proof, explicit exclusions and dependencies.
- [ ] Submit a cyclic or cross-objective graph: it is rejected; refresh a valid graph to see stable ticket IDs and derived ready/blocked states.
- [ ] Inspect GitHub before launch: no issue was created by planning; ticket files from generic ticketise skills were ingested, not committed into the repository.

## Out of this ticket
Issue creation; launch; GitHub as task source of truth; modifying generic skills.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New core/src/otto/tickets.ts; mcp-server/src/otto/tickets.ts and ticket-tools.ts; dashboard ticket-graph-panel. Own internal graph and criterion records, not existing observed otto_tasks.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
#1823

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
New internal tickets/criteria/edges linked to objective and brief revision; uniqueness, scoped access and cycle validation. Keep replaceable observer projections separate. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 10. #1825 — otto: answer typed waits in a web “Your turn” inbox

Parent: #1815

## What the user can do
Answer a consequential question or connect missing access while unrelated objectives continue.

## Acceptance (check by using the product)
- [ ] Open Your turn, answer choices with default/deadline or follow a connection link; no secret can be requested or entered into the thread.
- [ ] Leave approval, irreversible choice, access, two-failed-attempt or budget prompts unanswered: they park/pause, never silently approve; reversible decisions use the recorded default after 24 hours.
- [ ] During work see at most three open questions per objective and one 24-hour reminder then silence; the initial adaptive interview is not capped and routine progress produces no notification.

## Out of this ticket
Mobile/push notifications; auto-approval; engine interview prose; provider operations.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New core/src/otto/waits.ts; mcp-server/src/otto/waits.ts and waits-api.ts; dashboard /otto/your-turn and question-panel. Own typed wait storage/resolution interface for ci, verification, slot, human and access; #1828 owns evidence-driven resolvers.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
#1823

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
New typed waits/questions with deadlines, answered/default/parked outcomes and deduplicated inbox/reminder delivery. Explicit scoped RLS/grants. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 11. #1826 — otto: launch one ticket with a server-created GitHub issue and linked attempt

Parent: #1815

## What the user can do
Launch a ready ticket from the web and follow its GitHub issue and worker sandbox.

## Acceptance (check by using the product)
- [ ] Launch once: the server records intent, creates the issue only now, and binds issue, internal ticket, attempt, account and sandbox; no GitHub token enters Otto’s sandbox. The admitted engine and worker context enforce supported standing constraints and retain the effective instruction revision snapshot.
- [ ] Repeat the launch or simulate a lost response: inspect the same issue/attempt, not duplicate work; uncertain external effects park for reconciliation.
- [ ] Use revoked repository/account access: launch is denied before effect and the thread shows an actionable access wait.

## Out of this ticket
Automatic graph frontier dispatch; merge queue; new provider/harness implementations; retrying ambiguous effects blindly.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New mcp-server/src/otto/ticket-launch.ts and github-effects.ts; core/src/otto/attempts.ts; dashboard launch-attempt-panel. Reuse server launch policy and #1822 intent dispatcher; minimal tools.ts/control.ts handler registration owned here, not rewrites.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
#1824, #1825

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
New attempts and external-effect correlation/receipt records, unique ticket-attempt and issue bindings; foreign keys to existing scoped resources. Use #1822 journal rather than another intent store. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 12. #1827 — otto: dispatch parallel frontiers under an attempt budget and PR slots

Parent: #1815

## What the user can do
Run multiple objectives concurrently while the server enforces a visible attempt budget and fair PR capacity.

## Acceptance (check by using the product)
- [ ] Start two objectives: independent ready tickets run within configured capacity and dependency-blocked tickets do not; exhausting one objective does not stop the other.
- [ ] Inspect usage at 80% and 100% of the attempt budget: one warning then a pause/question; no third attempt for a ticket without an explicit new owner decision.
- [ ] Race starts/retries: a single atomic reservation charges each admitted attempt once and grants/releases one PR slot; after restart reservations reconcile without duplicate launches.

## Out of this ticket
Monetary/token/duration budget enforcement; new CI jobs; unbounded retries; cross-org capacity sharing.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New mcp-server/src/otto/scheduler.ts, budgets.ts and slots.ts; dashboard budget-capacity-panel; core/src/otto/budgets.ts. Own scheduler background-lane registration and frontier arbitration, not observer runtime wiring.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
#1826

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
New budget ledger/reservations and scoped PR-slot leases with atomic admission, unique effect keys and reconciliation state. Attempt-count budget only in this slice. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 13. #1828 — otto: wake workers from observed typed waits and expiring access

Parent: #1815

## What the user can do
See why a worker is waiting and have the server resume it only when that wait is observably resolved.

## Acceptance (check by using the product)
- [ ] Wait for CI on a head: pending/stale/partial results remain waiting, while an exact-head observed resolution causes at most one durable message/wake intent.
- [ ] Restart the server while waiting: it resumes reconciliation without an Otto model turn just to wait; denied access parks only that objective.
- [ ] Inspect a sandbox/auth deadline or expired grant: the web shows the access/expiry wait before loss where observable; missing expiry facts stay unknown.

## Out of this ticket
Polling from agent/model loops; GitHub merge operations; automatic third attempt; assuming host ACK means runtime ready.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New mcp-server/src/otto/wait-reconciler.ts and attempt-lifecycle.ts; dashboard wait-status-panel. Use #1825 wait interface and #1822 message intents. #1827 owns background registration; expose a resolver adapter to that lane.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
#1820, #1825, #1827

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
Add attempt heartbeat/observable expiry fields and resolver dedupe cursors if not already covered by waits; no raw journal/prompts retained as evidence. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 14. #1829 — otto: request GitHub merge-queue entry through a recorded server intent

Parent: #1815

## What the user can do
Queue an eligible exact-head PR and see queue admission or refusal, without Otto merging directly.

## Acceptance (check by using the product)
- [ ] Request queue entry for an authorized ready PR: inspect recorded intent and GitHub receipt for that head; duplicate requests do not enqueue twice.
- [ ] Change the head, revoke access, or remove required proof: admission is refused/unknown, never a direct merge fallback.
- [ ] Observe queue removal or merge: the objective thread distinguishes those outcomes and waits for evidence rather than treating enqueue as completion.

## Out of this ticket
Direct merge; enabling auto-merge as fallback; changing branch protection; deployment.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New mcp-server/src/otto/merge-queue.ts and merge-queue-tools.ts; dashboard queue-panel. Extend #1826 github-effects adapter for enqueue only; #1826 finished before this ticket.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
#1821, #1828

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
No new table expected: use #1822 intents and #1825 waits; add narrowly typed queue outcome metadata if needed. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 15. #1830 — otto: complete criteria only from mechanical or explicit human proof

Parent: #1815

## What the user can do
Inspect each criterion’s proof and confirm non-code work yourself without an agent declaring it done.

## Acceptance (check by using the product)
- [ ] For a code criterion inspect exact-head checks/merge evidence and any required target-environment proof; stale, incomplete or unobserved evidence leaves it unknown.
- [ ] For a screen/service criterion require a visible artifact link; for non-code work open a document plus the unverifiable list and record an explicit human verdict.
- [ ] Submit “done” text or an unobserved deployment claim from the worker: it cannot complete a ticket or objective; rejected/missing criteria keep dependencies blocked.

## Out of this ticket
Independent verification agents (later slice); building/deploying previews; trusting screenshots alone as mechanical deployment proof.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New mcp-server/src/otto/criterion-proof.ts and human-proof-api.ts; dashboard criterion-proof-panel; core/src/otto/criterion-proof.ts. Own criterion/ticket completion reducer consumed by #1827 scheduler, not observer task projections.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
#1821, #1824, #1828

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
New human attestations and criterion-to-evidence bindings with actor/time/revision/head/target where relevant; server-only derived completion, scoped append-only proof history. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 16. #1831 — otto: issue a final objective receipt with limits and cancellation

Parent: #1815

## What the user can do
Open one concise final result with proof, mandatory omissions/assumptions and attempt usage versus estimate.

## Acceptance (check by using the product)
- [ ] Finish an objective: receive one final inbox item opening a three-line summary, proof links, checks, mandatory “Not done / Assumed”, duration and attempt usage versus estimate; unknown cost is labelled unknown.
- [ ] Use cancel in one gesture: pending work is cancelled and running work gets a durable interrupt/stop request; already merged changes are explicitly not silently undone.
- [ ] Reopen after refresh/reconciliation: the receipt stays bound to the proof/brief revisions and does not duplicate notifications or invent success for parked work.

## Out of this ticket
Automatic git revert/production rollback; monetary cost accuracy without observed data; push notifications; worker self-certified completion.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New mcp-server/src/otto/receipts.ts and cancellation.ts; dashboard receipt-panel; core/src/otto/receipts.ts. Use existing intention, scheduler and inbox interfaces; this ticket owns final objective aggregation.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
#1829, #1830

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
New immutable receipt revision/evidence references and cancellation state if absent; deduplicate final inbox delivery using #1825 storage. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.

## 17. #1832 — otto: show day-one objective interruption and waiting measures

Parent: #1815

## What the user can do
Inspect a scoped web report of observed interruptions, verification lag and waiting causes for the dogfood objectives.

## Acceptance (check by using the product)
- [ ] Open the report after using Armada and Skillpack objectives: distinguish necessary/avoidable/unclassified interruptions per observed merged PR; absent denominator is unknown, not zero.
- [ ] Inspect merge-to-target-verification lag, observed-proof completion share and wait duration by typed cause; missing target proof remains unknown rather than a fabricated duration.
- [ ] Switch organization/repository filters: totals and links never expose hidden objectives or private sandbox evidence.

## Out of this ticket
New CI job; external analytics platform; mobile; claims of successful dogfooding without actual product evidence.

## Owned files / areas
Paths below packages/ are relative to packages/. New DTO modules remain browser-safe and are re-exported only as needed.
New mcp-server/src/otto/metrics.ts and metrics-api.ts; dashboard /otto/measures route; docs/otto-first-slice-acceptance.md dogfood walkthrough. Read event/proof/wait records, do not edit launch or completion policy.

Own only these feature modules and their targeted unit tests. Shared export/route registration changes are minimal named integration hunks, not ownership of the containing file. Consumers import the producer’s contract; do not rewrite a dependency’s module.

## Blocking dependencies
#1831

## Delivery boundaries
Planning source: #1815 and its owner comments; #1816 authorizes only server tools that record intent before effect. Web first. Skills run unchanged through Skillpack and must not know Armada. No new CI job, direct merge, deployment or production operation. Use existing launch/auth/provider policies; unknown evidence is never done.

## Migration discipline
None expected: aggregate existing timestamped state and evidence; add only an additive scoped index if demonstrated necessary. Follow docs/database-migrations.md: append only; choose a unique 14-digit version greater than current origin/main at implementation time and recheck before merge; coordinate versions, never edit an applied migration. Explicit RLS and grants for new user-JWT access, no secret/hash/ciphertext reads, named returned columns on JWT writes. Regenerate database.types.ts for schema changes. Migration application is owner-controlled through the validated release path, not this ticket.
