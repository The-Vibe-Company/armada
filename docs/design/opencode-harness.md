# OpenCode as the third harness

Design-only first PR for #1164, under #1160. No harness is enabled by this PR.
**Owner hold:** draft for discussion; do not start any implementation slice.
All implementation choices below are recommendations, not approved decisions.

## Current state

- `packages/core/src/contract.ts` defines `HARNESSES`; `models.ts` and
  `credentials.ts` separately define `MODEL_CATALOG` and `HARNESS_KINDS`.
- `packages/provider-boat/src/provider.ts` maps native Boat agents/capabilities;
  `packages/provider-modal/src/composed.ts` separately declares capabilities.
- `packages/agent-runtime/src/runtime.ts` hard-codes two drivers and validation;
  `claude.ts` and `codex.ts` implement `protocol.ts`'s Driver/Turn contract.
- The database harness enum, dashboard pickers and
  `apps/ios/Armada/Model/AgentValues.swift` also encode the two choices.
- Modal uses our runtime; Boat still uses its native runner. Neither gains
  OpenCode here. The acceptance smoke is a later implementation gate, not done.

## Interface spike and decision (2026-11-12)

Recommend a private, long-lived **OpenCode V2 server**, controlled by the released
`@opencode/client`, rather than ACP or spawning one CLI process per prompt.
Pin the implementation spike to `@opencode/cli@2.2.7` and
`@opencode/client@2.2.7`; lock packages and native artifact integrity in its PR.
[Published CLI metadata](https://registry.npmjs.org/@opencode/cli/2.2.7) and
[client metadata](https://registry.npmjs.org/@opencode/client/2.2.7) identify these versions.

Local, credential-free probe: downloaded that Linux CLI outside the repository;
`opencode --version` returned `opencode v2.2.7`; `opencode serve --help`
advertised the V2 API server with hostname/port options. This is an interface
spike, **not** a model execution or restart/usage parity result.

The [V2 API reference](https://opencode.ai/docs/api) exposes session creation,
inbox delivery (`steer` or `queue`), interrupt, messages, token usage and idle
outcomes; its durable session log is experimental.
Map one native session ID to an Armada conversation; translate native messages
into existing runtime events/journal, never expose raw credential-bearing payloads.
Use native steering only after its delivery semantics pass the driver spike.
Interrupt must stop active execution without automatically resuming parked work.
For resume, reopen the persisted native session and verify it without sending text.
Normalize harness-reported tokens once per native message into each Armada turn;
missing usage stays unknown, never zero. Keep monetary policy in #1163.

Important correction: unversioned server/SDK documentation redirects to V1.
The [migration guide](https://opencode.ai/docs/migrate-v1/) names
`@opencode/client` for V2; neither `@opencode-ai/sdk` nor its `/v2`
export establishes OpenCode V2 compatibility. ACP is not selected: the server
surface directly exposes the session/control/usage data we need; this is not a
claim that ACP lacks those features.

Before driver implementation, a credential-free fake-endpoint spike must prove
prompt, steering/queue ordering, interrupt, replay deduplication, restart/resume,
and per-turn token mapping at the pinned version. Save reproducible commands and
fixtures in that PR. If any operation cannot meet Driver/Turn, revise this decision
rather than advertise unsupported capabilities. No live DeepSeek call was made.

## Open questions for the owner

1. **Server/client or ACP?** Recommend the pinned V2 server/client approach above,
   conditional on the executable spike proving lifecycle and usage semantics.
   Should ACP be evaluated head-to-head before approving that choice?
2. **Which model access ships first?** Recommend DeepSeek-compatible endpoint plus
   an OpenCode-plan API key via #1162; defer interactive subscription login until
   terms and persistence are verified. Is that initial access scope sufficient?
3. **How far should the single harness table reach?** Recommend browser-safe core
   descriptors with generated iOS values, keeping server driver factories and SQL
   migrations separate. Approve that boundary rather than a broader code generator?

## Proposed target and runtime-owned configuration

One browser-safe core harness descriptor table owns IDs, labels, model defaults,
credential-kind references and baseline capabilities. Derive existing exports
instead of adding another list. Provider restrictions stay explicit overrides;
driver factories remain server-only. Generate the iOS harness values from this
table with a checked-in artifact, not a hand-maintained third-case list.
SQL enums still require additive migrations, not a runtime-generated schema.

The runtime writes non-secret V2 `opencode.json` outside repository checkouts:
`model`, `providers.<id>.package`, `settings.baseURL`, credential env-name
references, allowed model IDs, MCP configuration and `update: "disable"`.
For a custom endpoint use `@opencode/ai/providers/openai-compatible`;
these are [V2 provider fields](https://opencode.ai/docs/providers/), not V1
`provider/npm/options`. The model connection supplies endpoint/model selection;
Armada does not host a proxy. Reject credentials embedded in endpoint URLs.

#1162 owns connection resolution and secret delivery. Consume its private
runtime bootstrap, user over org; never invent a parallel credential store.
Pass keys only to the native child environment/private channel, never argv,
repository files, goldens, logs or API responses. Verify V2 credential persistence,
config precedence and MCP secret handling in the spike before enabling launches;
do not assume V1's auth-store path. Bind the server to loopback, not a hosted port.
Persist native conversation state with the existing runtime checkpoint; do not
snapshot credential material. API-key access to an OpenCode plan is in scope;
interactive subscription logins require vendor-terms verification first.

## Independently mergeable slices and staging verification

Every later PR uses a fresh main-based `codex/1164-<slug>` branch, `Refs #1164`,
and records exact checks/results. Only the coordinator holds staging credentials.

1. **Design (this PR):** no deploy prerequisite. Coordinator opens this document,
   verifies linked V2 evidence and ownership/slice boundaries; no runtime change.
2. **Harness table:** derive validators, model/credential exports and capability
   consumers; generate iOS values. Delete duplicate ID/label/default tables.
   Local checks: existing harness tests, typecheck, generator drift check.
   Staging: launch Claude and Codex on Modal; send a follow-up, interrupt, resume,
   inspect logs. Expect unchanged model selection, events and terminal status.
3. **Pinned executable spike:** fake endpoint and V2 control/usage fixtures only;
   no public OpenCode launch. Delete throwaway probe code after fixtures replace it.
   Staging: rerun the pinned probe in a disposable Modal sandbox; all lifecycle
   assertions pass, no key/config material appears in returned events or snapshot.
4. **Modal driver + API/CLI:** additive enum migration and runtime install;
   consume #1162 connections, implement Driver/Turn and capability selection.
   Delete two-harness dispatch branches replaced by descriptor-driven dispatch.
   Staging: configure owner-supplied DeepSeek connection; launch OpenCode on Modal,
   ask for a short answer, send a follow-up, steer while busy, interrupt, resume,
   send again and read logs/usage. Expect answer, same conversation, cursor replay
   without duplicates, correct terminal outcomes and nonzero reported tokens.
   Repeat with an OpenCode-plan API key. Include runnable commands in that PR.
5. **Dashboard + iOS:** derive picker/model choices and render existing usage DTOs;
   delete remaining hard-coded picker lists. Staging: select OpenCode, launch with
   the saved connection, reopen session on web/iOS; model and tokens match API.
6. **Boat:** only after #1161 runtime parity/removal of native runner; reuse driver,
   no alternate Boat-native OpenCode path. Staging: repeat slice 4 on Boat with
   the same connection; lifecycle and tokens match Modal.

## Ownership, acceptance and Later

#1161 owns Boat runtime/removal; #1162 owns model connections; #1163 owns cost
aggregation/pricing; #1165 owns Docker placement. Request missing contracts in
the relevant PR rather than implementing a sibling's subsystem.
Final acceptance: coordinator runs the post-deploy smoke lifecycle plus slice 4
against its DeepSeek endpoint on Modal, observes answer and per-turn tokens, and
checks that enabling OpenCode added no new hand-maintained harness list.
Later: interactive subscription flows pending terms, ACP, additional provider
quirks, multi-tenant isolation beyond existing Armada rules. No promise of native
steer, restart continuity or complete usage until the executable spike proves it.
