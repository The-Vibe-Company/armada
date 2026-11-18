# Native agent path retirement plan

[#2602](https://github.com/The-Vibe-Company/armada/issues/2602) covers the investigation and plan. The owner decides whether and when to change either provider default and authorize deletion. The design decision is to retire the provider-specific agent paths in favor of Armada's enrolled runtime while retaining provider-specific compute and storage. A selector change affects future launches. Existing sandbox rows, generations, history cursors and request receipts retain their original routing.

## What runs today

Code baseline `4c78a45da09efd9810e1f2a22b817d6ce1bf4a83`. [Server config](../packages/mcp-server/src/config.ts) defaults both `ARMADA_BOAT_AGENT_PATH` and `ARMADA_MODAL_AGENT_PATH` to `native`. [Server assembly](../packages/mcp-server/src/serve.ts) requires installed Boat runtime artifacts for its runtime default. Modal's runtime default requires `ARMADA_MODAL_DIALOUT=1` and a matching manifest. [Placement](../packages/core/src/launch-placement.ts) and [launch admission](../packages/core/src/launch.ts) route before allocation. A refusal or runtime failure never retries on native.

| Environment | Boat effective default | Modal effective default | Evidence |
| --- | --- | --- | --- |
| Repository baseline | Native | Native | Config fallback when both settings are unset |
| Staging | Unverified | Unverified | No current coordinator config read or authenticated discovery output supplied |
| Production | Unverified | Unverified | No current coordinator config read or authenticated discovery output supplied |

[Railway IaC](../.railway/railway.ts) leaves variables owner-managed. A deploy manifest or an older smoke result cannot attest to today's settings. Before cutover, the coordinator records the exact server deployment SHA, environment and UTC timestamp, and reads only the selector values (including unset), Modal dial-out enablement and runtime artifact presence/version from the effective server configuration. Cross-check with authenticated `launch/options` (`boatRuntime.defaultPath`, `modalRuntime.defaultPath`, explicit runtime and OpenCode capability) and a read-only aggregate of existing Boat and Modal rows by harness, persisted route and status. Record counts for retained/stopped rows as well as running rows. Keep credentials, manifest contents and sandbox identifiers out of the ledger. Discovery establishes the default, the row aggregate establishes existing routing, and an actual receipt and history establish the exercised launch path. This ticket provides the code-derived matrix below pending those environment readings.

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

The [Boat](boat-runtime-first-prompt.md) and [Modal](modal-runtime-first-prompt.md) runtime notes track incremental support and acceptance. Later entries supersede earlier refusals where code now supports the flow. Keep these explicit decisions open for both cloud providers before switching:

- **Admission and account compatibility.** Ordinary enrolled launches require an authorized model-account binding. Inventory unbound legacy credentials, private/scoped child launches and requested helper capabilities. Provide parity or get explicit owner approval for the transition of each affected cohort. Verify account/version pinning and failure before allocation.
- **Templates and tooling.** Raw application-secret bindings and pinned local stdio MCP remain refused by the runtime. Cover plain templates and routines, frozen readable variables, remote MCP, skills, workdir/init and GitHub renewal. For secrets and stdio, require an approved replacement or an explicit scope decision with caller-visible outcomes and migration guidance. Preserve resource authorization and secret isolation.
- **Conversation lifecycle.** Runtime follow-up accepts the first turn or an existing conversation. Arbitrary additional conversations and corresponding parallel activity need a parity or product decision. Verify the admitted per-turn override matrix separately from new-conversation support. Existing native sessions and provider cursors need a drain or historical-read plan.
- **Operational parity.** Verify launch with and without prompt, first/later send, wait/status/logs, steer/interrupt/exec by harness capability, webhooks, usage/cost, outputs and work preservation. Exercise owner/scoped access, empty and populated stop/wake, generation fencing, cleanup and deterministic replay. Record matched cold, warm and resume timings against native where applicable. Keep unsupported features recorded as refusals.

## Ordered work and acceptance evidence

| Step | Change or decision | Evidence required before proceeding |
| --- | --- | --- |
| 1. Baseline and decide parity scope | Coordinator captures both deployed defaults and existing row cohorts. Owner resolves every admitted native feature gap and approves explicit transitions for unsupported cohorts. | Signed-off matrix with deployment SHAs, sanitized discovery and row counts, actual feature usage, named owners for gaps and preserved contracts. |
| 2. Land parity changes separately | Address admission/account, secrets/stdio/helpers, scoped access and conversation gaps in bounded PRs. Keep both selectors and old row routing. | Deterministic tests at each owning boundary and a recorded outcome for each refused flow. Prove authorization, replay and failure without fallback. No new required check. |
| 3. Promote Modal first | Exercise explicit dial-out, then ordinary launch with the coordinator-selected Modal staging default. Preserve native controls for existing rows. | Exact-SHA staging receipts with `runtime.kind`, epoch, persisted `runtimeTransport:dialout`, runtime history and matched timings. Run the ordinary and explicit cases in the [Modal runbook](modal-runtime-first-prompt.md) for each supported harness and account class. Include owner-enabled Docker regression checks. Existing native reads/controls and enrolled reads/controls both work. |
| 4. Decide Boat separately | Coordinator validates explicit and ordinary Boat runtime parity on its own sandbox under separately authorized conditions. Boat stays outside CI, staging acceptance and the release gate. | Coordinator-only, on-demand Boat evidence using the [Boat runbook](boat-runtime-first-prompt.md) and provider parity's `--only boat --production-boat` for production parity. Record actual `boatRuntime`, enrolled receipt, archive source, cleanup, matched timings and all admitted harness/account classes. Record `boat: not part of the release gate` for release gating. |
| 5. Authorize new-launch cutover per provider | After its evidence is accepted, the owner authorizes each provider's production default change through the normal deployment process. Record exact SHA, settings, approval and time. | Ordinary launches use enrolled routing and existing rows keep their routes. Observe at least one full successful production day per provider after the switch, including admission/finish errors, latency, event continuity and recovery. Any rollback changes only the affected provider selector to native for future launches. Keep enrolled artifacts and old routing available. A rollback restarts that observation window. |
| 6. Drain and retire admission | After the owner approves retirement, split deletion into a provider-scoped new-launch cleanup and subsequent compatibility cleanup. Gate each change on that provider independently. | Owner approves the compatible-release recovery point before removing native admission. Verify no new native allocations or unexpected native-only callers. Document terminal/retained native rows, pending/replayed requests, outstanding capacity leases, cursor/receipt handling and approved historical access. Keep compatibility while any old row can wake, be read or require preservation. |
| 7. Delete provider-specific control and data paths | Separate Modal tunnel teardown from Boat SDK agent teardown. Remove shared native launch only after both providers and compatibility callers have cleared it. Split any additive schema retirement into later owner-authorized work. | Zero remaining consumers of each removed capability, with measured row/ingest/queue counts and approved history handling. Verify provider binding, snapshots, machine lifecycle, bootstrap exec, outputs, scoped access, auth publication and runtime resume are still served. Verify deploy and rollback paths against the removal SHA before authorizing cleanup. |

While native admission remains, roll back future launches using the affected provider's selector and keep the matching artifacts available. Once native launch admission is removed, recovery requires a compatible application release even if old-row controls still work. Confirm a recoverable release before deleting events or schema. A successful production day gates deletion, and the old-row drain independently gates deletion.

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

Also retire the owning tests and fixtures when their last caller goes away. Boat examples include `native-cwd.test.ts`, `native-claude-mcp.test.ts`, `native-usage.test.ts`, `native-usage-capture-v1.py`, `native-writer.conformance.ts` and `native-install-race.conformance.ts`. Server examples include `native-idle.test.ts` and `native-webhook-prompts.test.ts`. Retain tests of shared behavior, historical data and enrolled runtime security contracts.

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
| [`provider-modal/distribution.ts:38–115`](../packages/provider-modal/src/distribution.ts#L38-L115) | 78 | Native artifact install, runner start and environment restore. Keep shared image and snapshot preparation |
| [`provider-modal/composed.ts:114–176`](../packages/provider-modal/src/composed.ts#L114-L176) | 63 | Runner transport, signing, distribution and ingest assembly. Keep scoped binding |
| [`provider-modal/store.ts:218–273`](../packages/provider-modal/src/store.ts#L218-L273) | 56 | Native stored event reads and ingest writes. Keep machine/image storage and approved historical reads |
| [`mcp-server/config.ts:104–116`](../packages/mcp-server/src/config.ts#L104-L116) | 13 | Provider selectors and fail-closed startup requirements during transition |
| [`mcp-server/serve.ts:288–325`](../packages/mcp-server/src/serve.ts#L288-L325) | 38 | Boat default and custom endpoint policy assembly |
| [`mcp-server/serve.ts:380–408`](../packages/mcp-server/src/serve.ts#L380-L408) | 29 | Modal default policy assembly |
| [`mcp-server/serve.ts:566–576`](../packages/mcp-server/src/serve.ts#L566-L576) | 11 | Legacy history lookup for Langfuse |
| [`mcp-server/serve.ts:753–807`](../packages/mcp-server/src/serve.ts#L753-L807) | 55 | Native prompt settlement and steer recovery workers |
| [`mcp-server/control.ts:356–415`](../packages/mcp-server/src/control.ts#L356-L415) | 60 | Native subscription capabilities and launch discovery shapes. Preserve compatible client discovery |
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
| [`core/launch-secrets.ts:1–56`](../packages/core/src/launch-secrets.ts#L1-L56) | 56 | Native secret template delivery and taint. Preserve taint for historical rows |
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

### Deletion PR boundaries

- **Modal tunnel removal.** Trace references to the generation grant, runner port/authenticated transport, ingest route, stored event cursor, usage projection and runner artifact before deleting them. Keep image creation, snapshot/retention, SSH used for goldens, Modal binding, common runtime distribution and host bootstrap. If retained native logs still require the store, keep a read-only decoder until the history policy is fulfilled.
- **Boat agent API removal.** Trace SDK prompt/status/conversations/events/steer/interrupt, native cwd/MCP/usage scripts, native credential preparation and subscription observation. Preserve golden exec, VM activation/stop/delete, provider authentication, work preservation and output access. Keep native event decoding where historical clients still need it.
- **Shared compatibility cleanup.** Follow the inventory through package exports, client discovery, worker registration, fixture and release packaging references. Drain or account for native webhook and steer rows, native capacity mappings and old Modal event rows before any data cleanup. Handle schema in separately approved append-only migrations. The runtime still uses harness-native Codex/Claude drivers and session IDs, auth publication, native login/import and shared failure normalization. Preserve those contracts, including `runtime-native-auth.ts` and native runtime artifact validation. The word “native” in a filename alone gives no removal authority.
