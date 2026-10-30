# V2 hygiene pass 3 — THE-2035

Audited merged main `22888c0064d223d62515fb2eb4fdabc9a1022837` (2026-10-30)
against [the brief](v2-desktop.md), THE-1982 and Spec 8/8 (THE-2011).
This continues [pass 1](v2-hygiene-1.md) and [pass 2](v2-hygiene-2.md), including
THE-2032's addendum. The installed `test-audit` replaces the ticket's older
`audit-tests-dev` name. Discovery was read-only, with separate app-test and
architecture lanes, before the cuts below.

Scope is V2: protocol, plugin-api, daemon, bundled plugins, app and desktop.
V1 core/dashboard/skills are excluded; CLI plugin conformance and CI routing
were inspected without editing them. In-flight THE-2016's Codex/OpenCode and
THE-2036's coordinator, server readers and room facts are excluded from edits.
Findings there are follow-ups, not claims about their unmerged branches.
No protocol source, recorded wire fixture, version or readiness bytes change.

## Test audit: cuts and surviving proof

Each candidate was checked against its complete test, production callers,
overlapping proof and history. No failing baseline case is removed to make a
check green. No new test-only production seam is added.

| Candidate, history and actual failure detected | Change, remaining owner, risk and focused proof |
| --- | --- |
| `app/test/anatomy.test.tsx`, “are found, with the title line and the theme”; skeleton `aeddf9c` (#327). Checks a fixed three-filename inventory, so a behavior-preserving relocation fails. | Remove the whole inventory test, closing the deferred row from passes 1 and 2. Neighboring rules directly read title/theme files; App imports, SSR, typecheck and production build require the app entry. No production/support deletion. Low risk; anatomy and build suites. |
| `app/test/build.test.ts`, Harbor title/22px fragment inside “shows every project a squadron…”; `2b1e7a6` (#346). | Remove only the four-line title fragment. The room browser test (`e90e623`, #348) checks the identical Harbor heading and computed 22px size after durable-chat reload. Keep hangar anatomy, navigation, sidebar-current and loaded-font checks. No support deletion. Low risk; build suite. |
| `daemon/test/keychain.test.ts`, “owner keychain wins; absent/locked entries fall back to gh without leaking source errors”; `754d8ac` (#330), modified by #338. | Remove the whole test with the retired daemon GitHub helper it alone calls. #353 (`7ac6593`) moved the live helper to the GitHub plugin. Extend that helper's existing credential test in `plugins/github/test/merge.test.ts` with the missing locked-source, sanitized-error and pre-abort cases. Keep successful declared-token/fallback prerequisites there. This removes a duplicate production implementation, not a security contract. Low risk; GitHub and credential suites. |
| `daemon/test/credential-keychain.test.ts`, scoped Linear read and Linux XDG subprocess assertions through `readLinearKey`; `88e57e0` (#331), retired by #353. | Keep both assertions through production `Keychain.read`; remove the unused accessor wrapper and its type. The real provider gets declared secrets from context. Atomic values, namespace isolation, permissions, symlink refusal and XDG-root behavior remain tested at the gateway. Low risk; credential-keychain and plugin-keychain suites. |
| `desktop/test/daemon.test.ts`, restart socket helper introduced by `ae5990e` (#345). Open/message waits had no deadline or guaranteed socket close; all seven declarations lacked test deadlines. | Bound the existing process tests and make restart waits abort with the test signal and always close the socket. Keep all assertions. Existing source-process and bundled-Electron smokes cover distinct boundaries. No new test or production seam; desktop suite. |

The room SSR field test's old name claimed it sends even though it only renders
markup; actual sending belongs to the browser test. Its absent-coordinator
branch remains valuable. Route cases overlap partially across room/hangar but
include distinct malformed-path cases; no broad deletion is justified here.

## Retained owners, continuing the earlier tables

The unchanged storage, folding, provider-read, security and coordinator owners
from pass 2 remain in force. Newer surfaces have these primary boundaries:

| Contract | Retained owner / distinct risk |
| --- | --- |
| Wire/version admission, event vocabulary, extension-preserving snapshots, chat/plugin envelopes | `protocol/test/protocol.test.mjs`; independent public wire contract. |
| Manifest/API/config admission before import; ownership, atomic registration, catalog discovery and readiness ordering | `daemon/test/plugins.test.ts`. Its default-reader test now proves credential-free activation and reader registrations; it is no longer the old hello-only duplicate listed in pass 2. |
| SDK tools/structured output, actual coordinator consumption and restart with selected model, provider failure redaction | `daemon/test/models.test.ts`; local synthetic HTTP responses exercise real bundled SDK providers. Conformance separately proves the reusable SDK contract. |
| Owner chat send/read, tool results, project isolation and durable restart; absent-coordinator refusal | `daemon/test/chat-server.test.ts`; real WebSocket, file log and faux coordinator. App browser proof independently checks DOM interaction. |
| Plugin switch/config persistence, declared-secret writes, no returned secret, restart acknowledgment and next-boot state | `daemon/test/plugins-server.test.ts`; socket/storage lifecycle, beyond form rendering. |
| Real Claude streaming process, native worker tools, capability scope/revocation, launch cleanup, stale generation, shutdown failures | `daemon/test/workers.test.ts`; host composition through actual local worktree/process and worker socket. |
| Local worktree provenance, keyed delivery, stale references, safe disposal, environment isolation, escalation and missing executable | `plugins/node-local/test/local-node.test.ts`; actual node facilities, distinct from host worker-service policy. |
| Every bundled provider's versioned seam | `scripts/test-plugins.ts` runs the published CLI conformance runner for the generated catalog; fixtures remain synthetic and bounded. |
| Client reconnect/cursor/refusal handling and plugin/chat RPC ordering | `app/test/client.test.ts`, client portions of room/plugins suites; independent client lifecycle. |
| Hangar squadron geometry, hit areas, counts and empty fleet | `app/test/hangar.test.tsx`; browser measures actual canvas/layout and follows links. |
| Session state/action matrix, missing ticket, report ordering/filtering and empty files | `app/test/session.test.tsx`; browser independently owns click/keyboard navigation, focus, scrolling and disclosures. |
| Room choices, tool presentation, rail grouping and unavailable coordinator | `app/test/room.test.tsx`; browser owns actual send/answer, reload and rail interaction, rather than another render-only smoke. |
| Plugin schema form variants, refused providers, unsupported minor, non-restartable daemon and late replies | `app/test/plugins.test.tsx`; browser owns actual forms/switches/secrets and restart composition. |
| Source-wide title/fonts and theme/cn agreement | `app/test/anatomy.test.tsx`; these architecture contracts cover modules beyond today's browser routes. |
| Built JS budget, lazy Motion, loaded fonts, credential clearing, same-node live update and screen interaction | `app/test/build.test.ts`; retain the actual browser boundary. |
| Source child readiness/static serving, reaping, restart on same/fallback port, quit race, startup failure, SIGKILL and spawn errors | `desktop/test/daemon.test.ts`; finite deadlines and cleanup. |
| Electron bundle/native binding/configured coordinator | `desktop/test/bundled-daemon.test.ts`; 60s build hook, 20s body, abort-aware socket waits. Native packaging is a different failure from source-process tests. |

## Architecture review

| Rule and location | Disposition |
| --- | --- |
| One credential implementation at the active provider boundary: `daemon/src/keychain.ts`. | Fixed: delete the retired GitHub fallback implementation and Linear accessor whose only callers were tests. Keep the real `Keychain` gateway and live plugin credential path. Daemon is a private V2 package; repository-wide caller search found no production consumer of these obsolete exports. |
| One active-phase vocabulary: `daemon/src/workers/service.ts`. | Fixed: use the existing protocol `activePhaseSchema` instead of another seven-string enum. No protocol source or accepted phase changes. |
| Shared screen error behavior: `app/src/screens/Project.tsx`. | Fixed: replace its copied daemon-error classification, tone and Reload markup with `DaemonProblem`, already used by Hangar/Settings. The existing multi-screen error test remains the owner. |
| Consumers own provider scheduling: `plugins/linear/src/poll.ts`, `plugins/github/src/github.ts`. | Follow-up under Spec 8: `TrackerPoller.start/#tick` and `GithubReader.start` now have only test callers; live plugins use `readNow/refresh`, with scheduling in daemon readers. Remove the retired loops and interval/status plumbing in a separate coherent cut. Preserve cancellation, deadlines, abort-ignoring non-overlap, watermarks and interrupted-append recovery embedded in those suites; do not delete whole tests just because they call start. |
| Secrets enter plugins through context: `plugins/github/src/keychain.ts`. | Follow-up under Spec 8: the live helper still spawns `gh auth token` after declared-secret lookup. #353 deliberately retained that fallback. Move it into host credential resolution with preserved precedence, cancellation and sanitized failures; changing this behavior casually is outside this pass. |
| Provider-independent host composition: `daemon/src/server/models.ts`. | Compatibility debt: ZAI/Azure environment presets still live in host boot. Actual model construction uses the registry. A later cut can move preset metadata behind provider configuration while preserving existing boot selections. |
| No unused UI overrides: `app/src/screens/Room.tsx`. | Follow-up after THE-2036: wrapper `now/zone` overrides have no callers (App passes project only; SSR tests call RoomView directly). Remove wrapper branches, preserving browser time/viewer-zone defaults and RoomView's real inputs. Do not touch the concurrent room file here. |
| Coordinator native tools/prompt, reader composition and room facts. | Owned by THE-2036. No contract change here. Reassess its merged outcome against the brief rather than auditing unmerged implementation as delivered. |

Earlier findings resolved on this baseline:

- Protocol vocabulary, generic plugin event dates, sky test seams and concurrent
  Knip exceptions: THE-2032's pass-2 addendum is present on main.
- Reader extraction: boot consumers select registry tracker/forge providers;
  concrete implementations live in bundled plugins, with context events/secrets.
- Model extraction: coordinator boot obtains model kinds/providers from the
  registry; model plugins construct SDK instances and the host bridges to pi.

Conforming boundaries: one generated catalog loaded at boot, manifest/config/API
checked before import, disabled providers not imported, declared-secret checks
and atomic registration. No hot reload, installation or config layering.
`plugin-api` has only Zod at runtime; its Node guard is a separate export.
Worker runtime/node binding is host-owned through the SDK, with generation
checks before native writes. Plugins do not open the event database or socket.
Provider imports of daemon event types are erased compatibility imports, not
runtime access. SPA production imports protocol/local UI only; dev/test daemon
imports do not enter its bundle. Electron owns window/process lifecycle, not
fleet rules. SQLite's append-only log is authoritative; pi memory is a replay
projection, and folding/rules remain pure. No V1 runtime dependency, Effect,
subscription OAuth, hosted state, relay or sync enters the V2 graph.

## Dead code and repeatable scan

```sh
bunx knip@6.43.0 --config knip.v2.json
```

The bundled-plugin source glob covers model-anthropic, model-openai-compatible,
node-local, claude and future packages. Extend explicit Node test/source discovery
to node-local, alongside Linear/GitHub. Providers without local test files use
the source glob and the retained daemon/conformance owners; avoid unmatched
optional test-glob hints by declaring test entries only where suites exist. App source globs already cover room, session, hangar
and Plugins; daemon globs already cover workers and boot. The old scan reported
three unused worker exports; the extended scan must include local-node test
callers before classifying provider internals.

Removed production paths are the credential helpers above. Also make
`WorkerProject` and `workerRequestSchema` local and delete unused `WorkerRequest`
in `daemon/src/workers/service.ts` (#354, `046f95a`). Their implementations are
internal, not package export entries. No dependency was proven removable.
No blanket export/type suppression or new concurrent-path exception is added.
Public protocol/plugin-api exports and live daemon package exports remain
contracts. Root `@types/picomatch`/`@types/proper-lockfile`, excluded V1 workspaces,
root TS discovery and Bun auto-discovery keep the same explicit scope
dispositions as the preceding reports. Zero findings do not prove that a
reachable but test-only method is live; the retired reader-loop follow-up above
records that limitation.

## Terminal, platform and verification

The suites use headless browsers, piped worker fixtures and explicit process
I/O. No V2 test requires a terminal, `/dev/tty` or the BSD `script` wrapper.
Linux XDG storage proof remains Linux-only. Electron packaging smoke loads the
real native binding but stubs OS access: it does not prove macOS window, Cmd+Q
or actual Keychain acceptance. Those checks still need a Mac. Modern Node with
`node:sqlite`, Electron's Linux libraries and pinned Chromium are required.

Local versions: Bun 1.4.4, Node 24.22.1. Exact focused/full check results,
independent review, PR head and latest-SHA CI evidence are recorded in the pull
request and ignored `plans/ship-pr-dev/runs/20261030-005719-armada/` artifacts.
