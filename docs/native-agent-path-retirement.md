# Native agent path retirement plan

This is the Step 1 design note for [#2733](https://github.com/The-Vibe-Company/armada/issues/2733). It supersedes [#2602](https://github.com/The-Vibe-Company/armada/issues/2602) under the owner decisions D2, D3 and NC in [#2835](https://github.com/The-Vibe-Company/armada/issues/2835). Armada retires the provider-specific agent paths and keeps provider-specific compute and storage. During the rollout, a selector change affects future launches. Existing sandboxes keep their persisted route until drained.

## What runs today

Code baseline `4c78a45da09efd9810e1f2a22b817d6ce1bf4a83`. [Server config](../packages/mcp-server/src/config.ts) defaults both `ARMADA_BOAT_AGENT_PATH` and `ARMADA_MODAL_AGENT_PATH` to `native`. [Server assembly](../packages/mcp-server/src/serve.ts) requires installed Boat runtime artifacts for its runtime default. Modal's runtime default requires `ARMADA_MODAL_DIALOUT=1` and a matching manifest. [Placement](../packages/core/src/launch-placement.ts) and [launch admission](../packages/core/src/launch.ts) route before allocation. A refusal or runtime failure never retries on native.

| Provider | Harness | With repository defaults | Enrolled replacement and harness-specific evidence still required |
| --- | --- | --- | --- |
| Boat | Claude Code | Native Boat API for ordinary launches. Eligible custom endpoints can select enrolled runtime when installed. | Prove API key, subscription and supported custom endpoints under enrolled Claude, including in-turn steer, MCP tool provenance, usage across resume and restored session continuity. Apply the Boat/Modal gaps below. |
| Boat | Codex | Native Boat API for ordinary launches. Eligible custom endpoints can select enrolled runtime when installed. | Prove API key and imported subscription, refresh, account-capacity settlement, reasoning/model selection, restart-style steer, usage and session continuity across a retained stop. Apply the Boat/Modal gaps below. |
| Boat | OpenCode | No native support. Ordinary launch selects enrolled runtime with artifacts, otherwise refuses. Explicit versioned runtime is also available when configured. Dashboard discovery has its own readiness checks. | Prove ordinary and explicit launch with supported accounts, ACP follow-up, resume and dashboard discoverability. Preserve it during Boat cutover. |
| Modal | Claude Code | Native Modal runner and authenticated tunnel. | Prove enrolled dial-out for supported API-key and subscription accounts, in-turn steer, tool provenance, usage and remembered context after wake. Apply the Boat/Modal gaps below. |
| Modal | Codex | Native Modal runner and authenticated tunnel. | Prove enrolled dial-out for API key, custom endpoint where offered and imported subscription, refresh, capacity settlement, model/reasoning controls, restart-style steer, usage and retained session continuity. Apply the Boat/Modal gaps below. |
| Modal | OpenCode | Native Modal runner and authenticated tunnel. | Prove ACP launch for supported accounts, model mapping, prompt/follow-up, controls, event/archive shape, usage and resumed context with dial-out. Apply the Boat/Modal gaps below. |
| Docker host | Claude Code | Enrolled runtime | Regression control for launch, steer, retention and resume on the owner-enabled host. |
| Docker host | Codex | Enrolled runtime | Regression control for reasoning, usage, stop/wake and resumed context on the owner-enabled host. |
| Docker host | OpenCode | Enrolled runtime | Regression control for ACP launch, send and remembered context on the owner-enabled host. |

## Decisions and parity prerequisites

- Raw application secrets follow Docker's delivery boundary on Modal (#2734) and Boat (#2735). Runtime templates may use pinned local stdio MCP (#2736). Verify authorization, scoped access, secret isolation, frozen configuration and GitHub renewal.
- Refuse launches using unbound legacy model credentials before allocation. Guide callers to connect or import a model account and select its binding (#2737).
- A sandbox has one conversation. First send opens it and subsequent turns reuse it. Refuse a request to start a second conversation (#2738).
- Enrolment accepts the current and immediately previous runtime protocol. Refuse older versions with a stable error, leave the sandbox resumable and re-bootstrap the current verified runtime artifact on resume (#2739, #2857). Runtime and Docker daemon protocol overlap and database deploy overlap are independent of native agent-path retirement.
- Drain old native rows (#2742). Delete the native routes, cursors and history readers with their callers. The retirement release ships without a historical decoder or native fallback.

## Release and drain sequence

| Phase | Required evidence and next action |
| --- | --- |
| Parity | Land #2734–#2739 in dependency order. Use the [Modal runbook](modal-runtime-first-prompt.md) for Modal and owner-enabled Docker staging evidence. Boat evidence is coordinator-only and on demand, outside CI, staging acceptance and the release gate. |
| Modal default (#2740) | Release with the runtime default on for new Modal launches. Complete one release cycle with that default, pass the production checklist and confirm the previous release is recoverable. This evidence gates the Modal drain and the Boat default change. |
| Boat default (#2741) | Release with the runtime default on for new Boat launches after Modal's checklist passes and #2735 lands. Complete one release cycle with that default, pass the production checklist and confirm the previous release is recoverable. The coordinator checks Boat on its own sandbox using the [Boat runbook](boat-runtime-first-prompt.md) and production parity with `--only boat --production-boat`. Release gating reports `boat: not part of the release gate`. |
| Drain (#2742) | Record counts by provider, persisted path and status before the run. For each eligible native sandbox, use existing work preservation and then the normal delete operation. Repeat the inventory and reconcile pending prompt/steer work and account leases. Leave a row in place if preservation or deletion has failed and record it for retry. |
| Delete (#2743–#2748) | After the default-on release cycle, checklist, recoverable previous release and successful drain, remove that provider's native path in the next release. Shared deletions wait for both providers and their owning tickets. Delete old public surfaces outright and update the Armada skill and coordinator commands where those surfaces break. |
| Drop schema (#2749) | Verify the code that last used the objects is deployed and its predecessor has drained. Ship the drop one deploy later, after the 180-second overlap, with one append-only migration. |

The coordinator records the previous release SHA and verifies that it can be restored under the deployed schema and runtime/daemon protocol versions before authorizing removal. During the default-on cycle, the selector can restore native admission for future launches. A cycle with a reverted default cannot qualify. Keep the runtime path available for existing enrolled rows during recovery.

### Production checklist

Record the release, deployment SHA, UTC date, effective settings and pass/fail evidence for each applicable item. Complete the checklist for Modal and again after the Boat default release. Exercise the Docker server alongside the cloud provider under check.

1. Launch through the ordinary default path and confirm the enrolled runtime receipt and first turn.
2. Send a follow-up and verify that it reaches the same conversation and appears in history.
3. Stop and resume. Confirm retained work and follow-up context, then clean up the checklist sandbox.
4. Exercise launch, follow-up, stop and resume on the Docker server.
5. Verify account counters and capacity settlement for the exercised turns.

### Drain invariants and crash boundaries

The coordinator owns the drain run. Existing turn, stop/resume, retention and deletion workers or user operations can still contend for the same sandbox. Use the existing preservation and delete operations with their lifecycle fences. The drain must not bypass them or delete provider machines directly. Resolve active turns through the normal lifecycle before preservation. Reconcile uncertain results from the persisted row and operation state before retrying.

| Persisted state | Drain outcome and recovery |
| --- | --- |
| Native and active, stopped or retained | Preserve recoverable work first. A failed or uncertain preservation leaves the row for reconciliation. |
| Preservation complete | A crash before or during the delete call leaves the preserved work available. On restart, re-read the row and use the normal idempotent delete path. |
| Delete requested or in progress | A crash before the response or report leaves the normal deletion owner responsible for reconciliation. Report completion only after terminal deletion is verified. |
| Deleted | A rerun skips the row. A crash before recording the report is recovered from the next inventory. |

| Provider | Native path | Enrolled path |
| --- | --- | --- |
| Modal | Drain after the Modal gate. | Keep existing rows on enrolled routing. |
| Boat | Drain after the Boat gate, coordinator only. | Keep existing rows on enrolled routing. |
| Docker host | No native cohort. | Exercise as the regression control. |

[#2742](https://github.com/The-Vibe-Company/armada/issues/2742) owns the implementation design, including the concrete awaits after durable writes and lease ownership. This note covers the rollout and deletion sequence. Config changes, the drain runner, provider operations, schema changes and deployed verification belong to their respective delivery tickets.

### Coordinator ledger

[Railway IaC](../.railway/railway.ts) leaves these settings owner-managed. Record effective selector values (including unset), Modal dial-out enablement, runtime artifact version, deployment SHA and UTC timestamp. Cross-check authenticated `launch/options` while the discovery fields exist. A repository default does not establish a deployed setting.

| Environment | Boat effective default | Modal effective default | Runtime artifact / dial-out | SHA / UTC / evidence |
| --- | --- | --- | --- | --- |
| Repository baseline | Native | Native | See server config and assembly above | Code-derived |
| Staging | Unverified | Unverified | Unverified | Pending coordinator record |
| Production | Unverified | Unverified | Unverified | Pending coordinator record |

For #2737, the coordinator ran a read-only count from CLI source on main (`9773b5fad`). The inventory covered the single real user's personal credentials and every organization returned by `armada org list --json` for that owner. The coordinator used `armada creds list --json` for personal credentials and `armada creds list --org <id> --json` for each organization, then counted model-kind rows missing an ID or version. Credential identifiers, names and values were omitted from the record.

| Environment | Unbound legacy model credentials | Measured at (UTC) | Evidence |
| --- | --- | --- | --- |
| Staging | 0 | 2026-11-19 02:34 | [Coordinator measurement](https://github.com/The-Vibe-Company/armada/issues/2737#issuecomment-6997917557) |
| Production | 0 | 2026-11-19 02:34 | [Coordinator measurement](https://github.com/The-Vibe-Company/armada/issues/2737#issuecomment-6997917557) |

Before #2742, capture a read-only aggregate grouped by provider and status for rows on the persisted native route. Include all observed statuses, including stopped and retained cohorts, and explicit zero counts for empty cohorts. Repeat after the drain. Keep identifiers, credentials and manifest contents out of the shared ledger.

| Provider | Status | Native count before #2742 | Native count after #2742 | SHA / UTC / evidence |
| --- | --- | --- | --- | --- |
| Modal | Record each observed status | Unverified | Unverified | Pending coordinator record |
| Boat | Record each observed status | Unverified | Unverified | Pending coordinator record |

| Provider | Default-on release / UTC | Checklist evidence | Recoverable previous release | Drain report / deletion release |
| --- | --- | --- | --- | --- |
| Modal | Pending | Pending | Pending | Pending |
| Boat | Pending | Pending | Pending | Pending |

## Deletion inventory

Counts are physical lines, including comments and blanks, at the baseline above. Whole-file counts apply to probable deletion units. Inclusive ranges in mixed files include surrounding code for review. Remove only the native-specific statements after tracing their callers. Historical migrations remain append-only.

### Whole-file candidates

| Path | Lines |
| --- | ---: |
| [`packages/core/src/launch-native.ts`](../packages/core/src/launch-native.ts) | 176 |
| [`packages/provider-boat/src/native-cwd.ts`](../packages/provider-boat/src/native-cwd.ts) | 665 |
| [`packages/provider-boat/src/native-claude-mcp.ts`](../packages/provider-boat/src/native-claude-mcp.ts) | 110 |
| [`packages/provider-boat/src/native-usage.ts`](../packages/provider-boat/src/native-usage.ts) | 396 |
| [`packages/provider-boat/src/event-cursor.ts`](../packages/provider-boat/src/event-cursor.ts) | 50 |
| [`packages/provider-boat/src/events.ts`](../packages/provider-boat/src/events.ts) | 111 |
| [`packages/provider-modal/src/grants.ts`](../packages/provider-modal/src/grants.ts) | 42 |
| [`packages/provider-modal/src/ingest.ts`](../packages/provider-modal/src/ingest.ts) | 91 |
| [`packages/provider-modal/src/transport.ts`](../packages/provider-modal/src/transport.ts) | 107 |
| [`packages/mcp-server/src/modal-event-usage.ts`](../packages/mcp-server/src/modal-event-usage.ts) | 46 |
| [`packages/mcp-server/src/native-idle.ts`](../packages/mcp-server/src/native-idle.ts) | 57 |
| [`packages/mcp-server/src/native-webhook-prompts.ts`](../packages/mcp-server/src/native-webhook-prompts.ts) | 227 |
| [`packages/mcp-server/src/subscription-boat.ts`](../packages/mcp-server/src/subscription-boat.ts) | 46 |

Also retire the owning tests and fixtures when their last caller goes away. Boat examples include `native-cwd.test.ts`, `native-claude-mcp.test.ts`, `native-usage.test.ts`, `native-usage-capture-v1.py`, `native-writer.conformance.ts` and `native-install-race.conformance.ts`. Server examples include `native-idle.test.ts` and `native-webhook-prompts.test.ts`. Retain tests of shared behavior and enrolled runtime security contracts.

### Branches in shared files

| Source and baseline range | Lines in range | Native branch or removal boundary |
| --- | ---: | --- |
| [`core/launch.ts:108–131`](../packages/core/src/launch.ts#L108-L131) | 24 | Native account admission, hydration, turn/exec checks and redaction hooks |
| [`core/launch.ts:181–213`](../packages/core/src/launch.ts#L181-L213) | 33 | Provider default and native secret binding options. Preserve versioned runtime admission while callers use it |
| [`core/launch.ts:287–318`](../packages/core/src/launch.ts#L287-L318) | 32 | Implicit versus explicit runtime, native-default admission and refusal boundary |
| [`core/launch.ts:369–382`](../packages/core/src/launch.ts#L369-L382) | 14 | Native cwd requirement, helper and connection admission |
| [`core/launch.ts:403–448`](../packages/core/src/launch.ts#L403-L448) | 46 | Custom endpoint re-entry, legacy credentials, native OpenCode model mapping |
| [`core/launch.ts:519–539`](../packages/core/src/launch.ts#L519-L539) | 21 | Native strategy selection and initial allocation environment |
| [`core/launch.ts:645–671`](../packages/core/src/launch.ts#L645-L671) | 27 | Persisted route fence and native versus enrolled readiness timing |
| [`core/launch.ts:901–934`](../packages/core/src/launch.ts#L901-L934) | 34 | Native harness/provider capability and reasoning checks |
| [`core/launch-placement.ts:19–30`](../packages/core/src/launch-placement.ts#L19-L30) | 12 | Provider default and Boat endpoint fallback. Retain TTL policy |
| [`core/provider.ts:27–210`](../packages/core/src/provider.ts#L27-L210) | 184 | Provider interface. Remove native agent operations and retain host operations and enrolled capabilities |
| [`core/sandbox-provider.ts:32–38`](../packages/core/src/sandbox-provider.ts#L32-L38) | 7 | Native infrastructure flags and auth paths. Replace remaining shared-runtime consumers before removal |
| [`provider-boat/provider.ts:370–399`](../packages/provider-boat/src/provider.ts#L370-L399) | 30 | Native repo cwd install |
| [`provider-boat/provider.ts:565–582`](../packages/provider-boat/src/provider.ts#L565-L582) | 18 | Provider-native conversations |
| [`provider-boat/provider.ts:598–769`](../packages/provider-boat/src/provider.ts#L598-L769) | 172 | Native variables, prompt preparation, usage, prompt state, steer and interrupt |
| [`provider-boat/provider.ts:770–895`](../packages/provider-boat/src/provider.ts#L770-L895) | 126 | Exec branch for native usage and stop quiescence. Retain host exec and work preservation |
| [`provider-boat/provider.ts:896–1015`](../packages/provider-boat/src/provider.ts#L896-L1015) | 120 | Native events, usage cursors and quiescence |
| [`provider-modal/provider.ts:156–165`](../packages/provider-modal/src/provider.ts#L156-L165) | 10 | Native runner call and enrolled guard |
| [`provider-modal/provider.ts:390–424`](../packages/provider-modal/src/provider.ts#L390-L424) | 35 | Runner boot, health and native environment restore. Retain physical preparation |
| [`provider-modal/provider.ts:1382–1680`](../packages/provider-modal/src/provider.ts#L1382-L1680) | 299 | Native cwd, GitHub/model/MCP setup, legacy epoch operations, agent turns and history. Keep host exec |
| [`provider-modal/provider.ts:1829–1867`](../packages/provider-modal/src/provider.ts#L1829-L1867) | 39 | Native quiescence/retention during stop. Keep host lifecycle |
| [`provider-modal/process-scope.ts:1–317`](../packages/provider-modal/src/process-scope.ts#L1-L317) | 317 | Native runner PID-based sealing. Keep shared baseline capture, process inspection and quiescence used by SSH and host lifecycle |
| [`provider-modal/distribution.ts:38–115`](../packages/provider-modal/src/distribution.ts#L38-L115) | 78 | Native artifact install, runner start and environment restore. Keep shared image and snapshot preparation |
| [`provider-modal/composed.ts:114–176`](../packages/provider-modal/src/composed.ts#L114-L176) | 63 | Runner transport, signing, distribution and ingest assembly. Keep scoped binding |
| [`provider-modal/store.ts:218–273`](../packages/provider-modal/src/store.ts#L218-L273) | 56 | Native stored event reads and ingest writes. Keep machine/image storage |
| [`mcp-server/config.ts:104–116`](../packages/mcp-server/src/config.ts#L104-L116) | 13 | Provider selectors and fail-closed startup requirements during transition |
| [`mcp-server/serve.ts:288–325`](../packages/mcp-server/src/serve.ts#L288-L325) | 38 | Boat default and custom endpoint policy assembly |
| [`mcp-server/serve.ts:380–408`](../packages/mcp-server/src/serve.ts#L380-L408) | 29 | Modal default policy assembly |
| [`mcp-server/serve.ts:566–576`](../packages/mcp-server/src/serve.ts#L566-L576) | 11 | Legacy history lookup for Langfuse |
| [`mcp-server/serve.ts:753–807`](../packages/mcp-server/src/serve.ts#L753-L807) | 55 | Native prompt settlement and steer recovery workers |
| [`mcp-server/control.ts:356–415`](../packages/mcp-server/src/control.ts#L356-L415) | 60 | Native subscription capabilities and launch discovery shapes. Remove native discovery keys with their client readers |
| [`mcp-server/launch-control.ts:200–215`](../packages/mcp-server/src/launch-control.ts#L200-L215) | 16 | Record native versus enrolled launch route |
| [`mcp-server/http.ts:267–330`](../packages/mcp-server/src/http.ts#L267-L330) | 64 | Native provider routing and first output observation |
| [`mcp-server/tools.ts:535–590`](../packages/mcp-server/src/tools.ts#L535-L590) | 56 | Native prompt IDs and history routing |
| [`mcp-server/tools.ts:890–946`](../packages/mcp-server/src/tools.ts#L890-L946) | 57 | Native wait and account queue lookup |
| [`mcp-server/tools.ts:1960–2045`](../packages/mcp-server/src/tools.ts#L1960-L2045) | 86 | Native steer receipts and settlement |
| [`mcp-server/tools.ts:2126–2205`](../packages/mcp-server/src/tools.ts#L2126-L2205) | 80 | Native exec admission, auth redaction and stop fence |
| [`mcp-server/tools.ts:2610–2641`](../packages/mcp-server/src/tools.ts#L2610-L2641) | 32 | Resolve native steer to a concrete run |
| [`mcp-server/data.ts:648–688`](../packages/mcp-server/src/data.ts#L648-L688) | 41 | Native webhook receipts, queue linkage and deferred steer cursors |
| [`mcp-server/mcp-lifecycle.ts:201–251`](../packages/mcp-server/src/mcp-lifecycle.ts#L201-L251) | 51 | Native MCP install and binding checks |
| [`mcp-server/sandbox-lifecycle.ts:132–285`](../packages/mcp-server/src/sandbox-lifecycle.ts#L132-L285) | 154 | Native lease reconciliation, terminal observation and idle stop |
| [`mcp-server/work-preservation.ts:207–275`](../packages/mcp-server/src/work-preservation.ts#L207-L275) | 69 | Native versus enrolled preservation before stop |
| [`core/launch-secrets.ts:1–56`](../packages/core/src/launch-secrets.ts#L1-L56) | 56 | Native secret template delivery and taint. Keep taint for enrolled rows where required |
| [`core/launch-plan.ts:1–48`](../packages/core/src/launch-plan.ts#L1-L48) | 48 | Native cwd/preparation fields |
| [`core/launch-variables.ts:1–34`](../packages/core/src/launch-variables.ts#L1-L34) | 34 | Native readable variable writer and enrolled configuration boundary |
| [`mcp-server/mcp-native.ts:1–172`](../packages/mcp-server/src/mcp-native.ts#L1-L172) | 172 | Native bootstrap and configuration writers. Keep snapshot scrub where still used |
| [`mcp-server/mcp-sandbox-provider.ts:1–46`](../packages/mcp-server/src/mcp-sandbox-provider.ts#L1-L46) | 46 | Historical native binding lookup |
| [`mcp-server/launch-credentials.ts:1–323`](../packages/mcp-server/src/launch-credentials.ts#L1-L323) | 323 | Native auth admission/hydration and redaction. Retain shared account resolution |
| [`mcp-server/model-auth.ts:1–573`](../packages/mcp-server/src/model-auth.ts#L1-L573) | 573 | Native observation, publishing and binding lookups. Retain account import and enrolled publication |
| [`mcp-server/subscription-migration.ts:1–237`](../packages/mcp-server/src/subscription-migration.ts#L1-L237) | 237 | Native source/target migration. Retain account state and encrypted storage |
| [`mcp-server/modal-launch-environment.ts:1–181`](../packages/mcp-server/src/modal-launch-environment.ts#L1-L181) | 181 | Native harness environment and pinned credential delivery |
| [`mcp-server/modal-integration.ts:1–320`](../packages/mcp-server/src/modal-integration.ts#L1-L320) | 320 | Runner ingest HTTP route, grants and event projection. Keep provider binding, storage and host assembly |
| [`mcp-server/sandbox-armada-access.ts:1–175`](../packages/mcp-server/src/sandbox-armada-access.ts#L1-L175) | 175 | Native delegated access bootstrap and generation checks. Preserve scoped access via its approved replacement |
| [`mcp-server/sandbox-access-child-launch.ts:1–216`](../packages/mcp-server/src/sandbox-access-child-launch.ts#L1-L216) | 216 | Native credential hooks on scoped child launch |
| [`mcp-server/account-turn-queue.ts:1–553`](../packages/mcp-server/src/account-turn-queue.ts#L1-L553) | 553 | Native versus enrolled queue lane, native prompt mapping and settlement. Keep capacity accounting |
| [`mcp-server/turns.ts:1–601`](../packages/mcp-server/src/turns.ts#L1-L601) | 601 | Native usage projection, collection and fallback. Keep merged history and shared usage |
| [`provider-modal/artifact.ts:1–18`](../packages/provider-modal/src/artifact.ts#L1-L18) | 18 | Runner artifact loader. Trace consumers before removing build/package inputs |
| [`provider-modal/embedded.ts:1–11`](../packages/provider-modal/src/embedded.ts#L1-L11) | 11 | Embedded runner loader. Trace consumers before removing build/package inputs |
| [`provider-modal/ports.ts:1–220`](../packages/provider-modal/src/ports.ts#L1-L220) | 220 | Native runner transport, distribution and ingest ports. Retain host and storage contracts |
| [`mcp-server/tools.ts:1809–1917`](../packages/mcp-server/src/tools.ts#L1809-L1917) | 109 | Ordinary native send, wake, credential preparation and prompt receipt |
| [`mcp-server/boat-delegated-access-provider.ts:1–119`](../packages/mcp-server/src/boat-delegated-access-provider.ts#L1-L119) | 119 | Boat-specific delegated generation provider |
| [`mcp-server/boat-delegated-access-script.ts:1–104`](../packages/mcp-server/src/boat-delegated-access-script.ts#L1-L104) | 104 | Boat-specific delegated generation control script |
| [`mcp-server/boat-delegated-access-bridge.ts:1–34`](../packages/mcp-server/src/boat-delegated-access-bridge.ts#L1-L34) | 34 | Boat-specific MCP bridge install/scrub |
| [`agent-runtime/main.ts:216–233`](../packages/agent-runtime/src/main.ts#L216-L233) | 18 | Legacy Modal generation-grant auth publication, alongside enrolled publication |
| [`agent-runtime/main.ts:445–461`](../packages/agent-runtime/src/main.ts#L445-L461) | 17 | Legacy Modal HTTP journal upload |
| [`agent-runtime/main.ts:603–610`](../packages/agent-runtime/src/main.ts#L603-L610) | 8 | Legacy Modal runner HTTP listener |
| [`agent-runtime/runtime.ts:134–157`](../packages/agent-runtime/src/runtime.ts#L134-L157) | 24 | Dial-out adapts requests to the shared HTTP handler. Remove only the external listener and preserve common command admission |
| [`dashboard/app/api/sandboxes/[id]/events/route.ts:42–74`](../apps/dashboard/src/app/api/sandboxes/[id]/events/route.ts#L42-L74) | 33 | Native event pagination route and cursor policy |
| [`dashboard/app/actions/sandboxes.ts:169–200`](../apps/dashboard/src/app/actions/sandboxes.ts#L169-L200) | 32 | Provider-specific native turn override policy |

### Deletion tickets and PR boundaries

The path references below point to inventory rows above. Counts give baseline range sizes or whole-file sizes. Measure native-only edits and include tests, fixtures and call sites in the actual diff budget. Every PR stays within 600 non-generated changed lines and one module. Split oversized work into parts under its ticket before review. Shared files are divided by the branch named here.

| Step and ticket | Inventory rows and owned removal |
| --- | --- |
| 1-11 · #2743 | Modal provider. `transport.ts` (107), `ingest.ts` (91), `grants.ts` (42), and native parts of `provider.ts` (10 / 35 / 299 / 39), `distribution.ts` (78), `composed.ts` (63), `store.ts` (56), `artifact.ts` (18), `embedded.ts` (11), `ports.ts` (220), and native-only parts of `process-scope.ts` (317). Split the runner/distribution removal from the ingest/transport work where needed. Keep host lifecycle, snapshots, Modal binding and enrolled bootstrap. |
| 1-12 · #2744 | Modal server integration. `modal-event-usage.ts` (46), native parts of `modal-integration.ts` (320), `modal-launch-environment.ts` (181), `mcp-native.ts` (172), and Modal tunnel parts of `control.ts` and `tools.ts` listed above. Separate agent-runtime part for the external listener, journal upload and legacy generation grant in `main.ts` (18 / 17 / 8) and the boundary at `runtime.ts` (24). Keep shared command admission and enrolled auth publication. |
| 1-13 · #2745 | Boat cwd and MCP installation. `native-cwd.ts` (665), `native-claude-mcp.ts` (110), the cwd install in `provider.ts` (30), and setup in the 172-line range. The cwd file alone exceeds the cap. Remove independent cwd routines and callers in bounded parts before deleting the rest of the file. Include the cwd/MCP tests and conformance fixtures in those parts. |
| 1-14 · #2746 | Boat events, cursor and usage. `native-usage.ts` (396), `event-cursor.ts` (50), `events.ts` (111), the Boat conversations range (18), and usage/event pieces of the 172 / 126 / 120-line `provider.ts` ranges. Split usage from events/cursors and put `subscription-boat.ts` (46) in a separate server part. Keep host exec and work preservation. |
| 1-15 · #2747 | Shared admission and native lanes. Core part covers `launch-native.ts` (176), the eight `launch.ts` ranges (24 / 33 / 32 / 14 / 46 / 21 / 27 / 34), `launch-secrets.ts` (56), `launch-plan.ts` (48) and `launch-variables.ts` (34). Server parts cover `native-idle.ts` (57), `native-webhook-prompts.ts` (227), native branches in `serve.ts` (11 / 55), `launch-control.ts` (16), `http.ts` (64), remaining native `tools.ts` ranges (56 / 57 / 86 / 80 / 32 / 109), `data.ts` (41), `mcp-lifecycle.ts` (51), `mcp-sandbox-provider.ts` (46), `sandbox-lifecycle.ts` (154), `work-preservation.ts` (69), `launch-credentials.ts` (323), `model-auth.ts` (573), `subscription-migration.ts` (237), `account-turn-queue.ts` (553), `turns.ts` (601), and the native delegated access files (175 / 216 / 119 / 104 / 34). Keep the enrolled handler in `mcp-server/runtime-native-auth.ts` (85 lines), including its publication wiring. Keep enrolled auth publication, account accounting, scoped access and shared work preservation. |
| 1-16 · #2748 | Selector and provider interface. Core parts cover `launch-placement.ts` (12), `sandbox-provider.ts` (7) and the native agent operations in the 184-line `core/provider.ts` interface range. Server part covers `config.ts` (13), selector wiring in `serve.ts` (38 / 29) and remaining native discovery in `control.ts` (60). Client parts cover the dashboard events route (33), turn override action (32), and affected discovery readers in dashboard, CLI, SDK and iOS. Update the Armada skill and coordinator commands with the breaking surfaces. |
| 1-17 · #2749 | Native persistence behind the ingest, selector and worker rows above. Re-inventory schema at execution time, including `modal_events`, `native_webhook_prompts`, `native_steer_cursors` and route columns such as `runtime_transport`. Drop only confirmed native-only objects after the deploy overlap and regenerate database types. |

Trace shared consumers before deleting code. Enrolled Codex and Claude drivers, harness session IDs, native login/import, runtime artifact validation, common auth publication, and shared failure normalization remain runtime contracts.
