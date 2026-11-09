# MCP bootstrap and gateway integration (#523)

## Production wiring

`LaunchStores.connections.prepare(provider, sandboxRecord, actor)` runs after
binding and repository init, before first prompt, including an idle launch.
`createMcpHttpIntegration(...).connections` implements validate/bind/prepare.
The server passes this same port through the MCP tool and API launch paths.

Boat's provider has production `beforeResume(provider, sandboxId)`,
`beforePrompt(provider, sandboxId)` and `beforeSnapshot(provider, sandboxId)` options. The installed generated Boat REST
SDK does not expose an in-process native `ensureRunning`: the adapter explicitly
GETs state, awaits beforeResume only when stopped BEFORE POSTing resume, waits
for actual readiness, then calls beforePrompt BEFORE POST /prompt. Bootstrap failure never submits the prompt.
The server callback uses the persisted provider ID + sandbox ID and authenticated
caller org/membership/access, not provider labels or a request's alleged owner.

Modal's additive bridge is `Provider.configureMcp({sandboxId, configuration})`,
where configuration is `{revision, servers}` using the HTTP/stdio union. Prepare
configures the existing runner after binding, not the pre-insert initial fork.
The Modal provider must invoke the same backend beforePrompt callback after its
actual restore, before creating a native turn. Missing configureMcp is an error,
not a successful connected launch. Runtime protocol/configureMcp, checkpoint
scrubbing and the provider-modal implementation remain owned by 510/513.

## Stable narrow leases, no plaintext token persistence

A server-only HMAC-SHA256 key is derived from ARMADA_ENCRYPTION_KEY using domain
`armada/mcp/lease-key/v1`. A lease token is an opaque HMAC of the canonical tuple
(sandbox UUID, SQL sandbox MCP generation, Linux physical boot UUID, connection
UUID, grant generation). The key and upstream authentication never enter a VM.
Only the SHA-256 token digest is stored in mcp_leases.

Reconciliation reconstructs the same token across replicas, process restarts and
parallel conversations. Its SQL expiry is refreshed to the provider-reported
physical expiry, bounded to 24 hours from reconciliation. No fixed ten-minute
lease interrupts a normal multi-hour turn. The native config does not need to
change when only the physical expiry is extended. A physical boot identity
change commits a sandbox-generation fence BEFORE configuration I/O, so an
installer error cannot roll back revocation of a restored snapshot's old token.

Short SQL transactions fence generations and publish/reuse leases. Installation
is serialized with a transaction-scoped advisory lock, not authority row locks
over SSH/runtime I/O: disable/revoke/stop can commit while installation runs.
Authority is checked again after delivery before recording configuration success.
The bootstrap receipt stores only physical UUID, revision digest and successful
installation bit. It contains no configuration, token or upstream secret.
New migration `20261110040000_mcp_bootstrap.sql` fences credentials minted by previous bootstrap mechanisms.

Boat's kernel boot ID can survive a real archive/restore. Before sending any
resume request after observing stopped, the caller-scoped `beforeResume` port
locks current membership and authorized persisted provider/sandbox identity,
then atomically CASes a configured bootstrap to unconfigured and increments the
SQL sandbox generation. Only the configured=true winner rotates; parallel
replicas and retries do not churn the fence. No bootstrap/old lease means no
generation change. Unauthorized callers cannot fence another private sandbox.
Failure aborts resume, and an ambiguous network outcome cannot undo the committed
fence: a now-ready retry reinstalls fresh native config in beforePrompt. No
configuration I/O runs before actual readiness. This also handles provider
autoarchive while Armada SQL still says ready. The Linux
/proc/sys/kernel/random/boot_id is supplemental identity, NOT a required physical
restore signal or a replacement for the pre-resume SQL fence. Other providers must supply trusted
`SandboxInfo.physicalGeneration`, changing on actual machine restore or volatile
runner replacement. Modal MUST NOT substitute the shared host Linux boot UUID;
its provider must use the actual machine/runtime incarnation. This is backend
metadata, never a label or a value supplied by a request.
Providers must report a future physical expiresAt; otherwise reconciliation
fails closed. For an ongoing turn, active leases nearing expiry receive a server-authorized
physical check (at most once per minute): the trusted persisted-identity resolver
uses current owner membership and immutable source-golden credential scope,
checks the current boot identity, then extends only still-valid, nonrevoked SQL
leases to the new physical expiry, bounded to a rolling 24-hour horizon. No model
restart or token/config rotation is needed when Boat extends a working VM TTL.
Unknown physical state never extends authorization; a different boot fences old
credentials. There is no unbounded lease or unauthenticated refresh endpoint.

## Native files and snapshots

Boat writes through ephemeral-key, host-key-pinned SSH stdin, never exec argv or
provider logs. Native configs are outside repositories and mode 0600. A separate
name-only ownership manifest prevents prefix-based deletion of unrelated public
native definitions and journals ownership before credential writes, so partial
I/O cannot orphan untracked transient entries. Snapshot preparation removes only
manifest-owned entries, the marked Codex block and owned entries in known Claude
config backup files; it preserves unrelated settings and repository .mcp.json.
Snapshot scrub errors abort Provider.snapshot. Modal's volatile runner config and
checkpoint cache scrubbing must be performed by its protocol/runtime owner.

Configuration delivery is not upstream health. Remote connect/status perform a
real SDK handshake and capability listings. Stdio executes only inside the VM;
it is configured readiness, never a control-server subprocess probe. The native
harness drivers must explicitly report unsupported resource/prompt mappings;
this adapter does not claim native parity merely because JSON/TOML was written.

## Fixed callback deployment

ARMADA_PUBLIC_URL is the MCP/gateway origin. ARMADA_DASHBOARD_URL is an independent
validated HTTPS origin (default https://armada.thevibecompany.co). OAuth redirects
to its fixed /auth/mcp/callback. That browser route sends a human Supabase bearer
server-side to POST /api/v1/mcp/oauth/callback. Service and MCP bearers are refused
before consuming state. Org/connection come only from actor-bound pending state.
Other actions require scoped body.org; an org membership cannot broaden an
organization-scoped Armada bearer. Definitions are complete immutable-scope
replacements: omitted authentication clears it and requires reconnect.

## Coordinator merge points (global main 59abc / 535 / 540 / 541)

Do not replace a newer Boat adapter wholesale with this isolated checkout's
older REST prompt implementation. Preserve actual native cwd, harness creation,
provider golden/capability work and model defaults. Port these additive hooks:

1. `LaunchStores.connections.prepare?(provider, sandboxRecord, actor)` and its
   await immediately after init, before the prompt/idle-ready branch.
2. `BoatProviderOptions.beforeResume?(provider, sandboxId)` only after trusted
   GET observes stopped, BEFORE actual resume (including ambiguous failures).
   Await the caller-scoped `createMcpHttpIntegration(...).beforeResume`; failures
   refuse resume. `beforePrompt?(provider, sandboxId)` remains after the existing
   real `ensureRunning`/resume and BEFORE native `createPrompt`. No cwd casting.
3. `BoatProviderOptions.beforeSnapshot?(provider, sandboxId)` before the actual
   snapshot call. Await it; never absorb its error and claim a saved artifact.
4. `Provider.configureMcp?({sandboxId, configuration})` for the Modal protocol-1
   authenticated additive operation; do not change existing runtime operations.
   Its `get` must also expose trusted `SandboxInfo.physicalGeneration` from the
   real machine/runtime incarnation, not the shared container host boot UUID.
5. `createMcpHttpIntegration(...).connections` to HandlerOptions, ToolContext and
   ControlOptions; `beforePrompt` takes provider, trusted providerSandboxId and
   authenticated `{userId,orgId}`; `beforeSnapshot` takes provider and sandboxId.
6. Server provider factories must pass verified caller/org context to the native
   beforePrompt resolver. The resolver looks up persisted identity and current
   membership/visibility, never trusting user labels or an alleged owner field.

The isolated main server data adapter has been repaired to persist input.visibility,
read/authorize sandbox.visibility/access_owner_id with current membership, and
carry source_golden_visibility separately into provider credential selection.
The real MCP private-fork and direct-JWT/server privacy regressions now pass;
no expectation was relaxed. The staged canonical gateway is version 2.4.0 and all
workspace package metadata is aligned with it.

No already-applied registry/provider/model/slot migration is edited by this lane.
The only new migration is `20261110040000_mcp_bootstrap.sql`. Canonical aliases in
scripts/db/generate.ts and generated core database.types.ts include the real MCP
tables and bootstrap receipt; the generated-types equality test now passes.


The HTTP adapter also exposes `drainInvalidations()` for startup/graceful control
and `renewActiveLeases()` for the production timer. Consumers maintain hash-only
canonical lease identities, revalidate affected leases before closing them and
update canonical expiry without breaking parallel sessions. Historical events
cannot close a newer valid generation. Two independent replica consumers are
covered with real SDK notification streams and durable SQL acknowledgements.
Remote status failures persist unavailable/needs_reconnect rather than leaving a
false connected row; a fresh successful probe can recover an unavailable grant.
Known narrow gateway credential patterns are masked in the existing core output
redaction path, including exec/log payloads.

The production server passes a `providerForSandbox(sandboxId)` resolver to the
HTTP integration's ongoing-turn renewal path. It resolves the persisted owner,
current membership, pinned backend binding and immutable source-golden visibility
before touching provider credentials. This must also be wired to Modal's factory
when that owned adapter is integrated. Unknown physical state never extends a
lease; the existing expiry remains a hard bound until a successful authorized
renewal. A new physical identity permanently fences old credentials.


## Review security repairs

Initial OAuth publication requires a per-callback actor-bound store:
`createMcpOAuthStore(sql,key,actorId)`. Its takePending consumes one encrypted flow
and captures the actor/org/grant generation plus the durable membership epoch
sealed at initiation. Unbound initial saveGrant calls are refused. Refresh CAS
still uses the exclusive consumed refresh owner/version fence.

New service-only mcp_actor_epochs rows survive member removal/readdition. The
new 40000 migration increments only the affected actor's epoch on membership or
role transitions, without rotating unrelated explicitly shared org grants.
Publication's SQL predicate locks/checks the current member and epoch only AFTER
token exchange, including admin permission for org identities. Removal/readd or
demotion/repromotion cannot revive a consumed callback. Use one actor-scoped store
per HTTP callback, never cache it per user. The default singleton is read/refresh
only, not an initial callback publisher. Seven deferred real HTTP/SQL tests cover
success, demote, remove, both readd cases, revoke and supersession; the role-only
negative control reproduced unauthorized publication and fails the regression.

MCP discovery has one operation-wide 15-second deadline, a two-second cleanup
budget, 64 aggregate pages, 10000 aggregate items, 4 MiB aggregate response bytes,
2048-byte cursors, cursor-cycle detection and eight concurrent discovery budgets.
Limits raise typed sanitized failures, never partial counts; SDK session DELETE
and local stream cleanup are independently bounded. The auto/OAuth metadata
phase also uses bounded fetches. Tests exercise all three cursor loops, page/item/
byte/cursor limits and a cancelled stalled list without wall-clock sleeps.

## Shared pinned stdio contract

`@armada/core` exports parsePinnedMcpStdio and MCP_STDIO_EXECUTABLES. Registry
admission and runtime owners should delegate their pin grammar to that pure
module instead of maintaining a second regex. Registry definitions retain npx
[-y|--yes] package@X.Y.Z or uvx package==X.Y.Z; backend delivery resolves only known
installed launcher paths using a fixed filesystem probe inside the VM, never a
control-server package execution or a user-supplied shell command.

Native npx argv is `--yes -- package@X.Y.Z ...`. Native uvx argv uses the documented
`--from package==X.Y.Z package ...` form. Both native config consumers use the
same canonicalization and reject unresolved/unpinned launchers. The real registry
SQL -> binding -> fixed-path probe -> native JSON/TOML regression covers both
launchers, rejects unpinned definitions and asserts configured readiness only.
Its independent VM filesystem/private configuration fixture is not a claim that
live cloud package health or Claude/Codex tool/resource/prompt parity was tested.
Root-owned managed-provider probes remain the cloud/harness conformance gate.

Primary CLI references: [npm npx](https://docs.npmjs.com/cli/v11/commands/npx/)
and [uv tools](https://docs.astral.sh/uv/guides/tools/#requesting-specific-versions).

## Executable managed Boat proof (root-owned operator run)

Helper: `scripts/mcp/managed-boat-probe.ts`. It uses the production Armada API-only
CLI client with existing authentication and ARMADA_URL, never provider keys or a
new OAuth grant. It deliberately requires disposable, connected authType=none
fixtures: pinned npx, pinned uvx and at least one public remote MCP connection.
Each selected connection needs a real native tool check. Resource/prompt native
mapping is explicitly NOT certified by this tool-only helper.

```
bun scripts/mcp/managed-boat-probe.ts --validate-program
bun scripts/mcp/managed-boat-probe.ts --execute --manifest /path/to/fixture-manifest.json
```

Minimal manifest shape (replace UUIDs/tool names with the root's trusted fixtures):

```json
{
  "org": "00000000-0000-4000-8000-000000000001",
  "golden": "managed-mcp-fixture",
  "connections": [
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000004"
  ],
  "checks": [
    {"connectionId":"00000000-0000-4000-8000-000000000002","tool":"echo","args":{"message":"$NONCE"},"resultIncludes":"$NONCE"},
    {"connectionId":"00000000-0000-4000-8000-000000000003","tool":"echo","args":{"message":"$NONCE"},"resultIncludes":"$NONCE"},
    {"connectionId":"00000000-0000-4000-8000-000000000004","tool":"echo","args":{"message":"$NONCE"},"resultIncludes":"$NONCE"}
  ],
  "timeoutSeconds": 360
}
```

Optional `checks[].eventNames` maps claude/codex to exact native event names when
the driver uses a different namespace. An override must still identify the chosen
Armada server UUID, not a shell tool. Prefer fixture calls that echo $NONCE. Use a
long-lived/briefly blocking fixture if a managed harness otherwise kills MCP
processes before their argv can be sampled; missing process evidence FAILS rather
than being treated as a successful native proof.

The helper launches each real model at medium, observes real native MCP ToolCall
results, compares both actual config files, samples real process argv and public
package-version metadata without printing them, checks for credential argv leaks,
waits for a settled turn, physically stops, then sends a new turn and repeats.
It requires the public gateway credential digest to change after physical resume.
It never reads process environ or model-auth files. Only boolean proof facts and
sandbox IDs are printed; raw errors, config, headers, prompts and transcripts are
withheld. Cleanup stops machines; disks remain under Armada's retention policy.
Syntax validation is not a managed run. This worker has NOT executed --execute;
the coordinator has the operator credentials and owns that actual native proof.

Coordinator merge must preserve the separately merged main6a690880 retention,
adoption and capacity-409 work, plus 535/540 actual native cwd and 541 capabilities.
The approved registry delta is ONLY the shared-parser import and
validatePinnedStdio delegation, with original invalid/control-character errors
and the authType=none gate unchanged. No SQL/access/privacy/grant code there moved.

### Actual managed native argv/header sentinel extension

The managed helper now launches idle first (post-init prepare), adds a separate
unmanaged public read-only MCP fixture with a random harmless
X-Armada-Argv-Sentinel header, then submits the FIRST native prompt. The extra
fixture is outside the Armada-owned config block, so it survives resume while
Armada's real gateway leases/config rotate normally. An additional native tool
check through that fixture is required in BOTH phases. The actual gateway
connection's native call remains required separately.

The VM inspector scans only recognized Claude/Codex native processes (including
claude-agent-sdk/cli.js and Codex app-server) and their descendants. It excludes
itself and its entire ancestor chain: the authorized exec command necessarily
contains the harmless sentinel and is NOT native leak evidence. No argv, header,
key, environment or model-auth file is returned. Reports contain boolean sentinel
presence, boolean credential-pattern presence and an explicit incomplete/null
state if native argv was not observable. The OS-process test independently proves
that a native-looking probe ancestor is excluded, while inline --mcp-config JSON
on a separate native child is caught for both standalone and SDK CLI forms.

Only --validate-program and the local observer regression have been executed in
this worker. Actual managed Boat first/resume/public-tool/sentinel results remain
ROOT-OPERATOR proof, not a completed claim. This helper supplies no model API
credentials in exec requests and never reads environ/auth files; runtime execEnv
is the separately owned GitHub-only private-bootstrap contract.

## Final review corrections: stop timestamps, development and OAuth I/O bounds

Restore now changes status=ready AND stopped_at=null in one fenced UPDATE,
conditioned on the locked sandbox generation, current owner/org membership and
absence of deletion. The real SQL/control stop -> provider resume -> beforePrompt
-> send regression asserts the timestamp is cleared BEFORE the native turn receipt.
Removing only stopped_at=null demonstrably reproduces sandboxes_guard's rejection.

ServerConfig.development comes only from NODE_ENV=development and is explicitly
forwarded through createMcpHttpIntegration to dashboardOrigin and OAuth broker
construction. Production remains HTTPS-only. The minimal broker development port
allows only fixed HTTP loopback browser redirects; resource/upstream endpoint
validation remains unchanged and HTTPS-only. Pure origin and actual integration
construction tests cover both sides of that boundary.

OAuth I/O is independently deadline/abort bounded with boundedOAuthFetch; live
MCP streams do NOT use that short network deadline. The status probe now owns ONE
budget starting before its asynchronous credential producer, so broker.access /
refresh and tools/resources/prompts discovery share the same overall deadline,
without nested capacity acquisition. Callback exchange also has a request-bound
budget and its actor-scoped publication store receives that operation signal.
Deferred real HTTP/SQL cancellation tests preserve consumed refresh uncertainty,
refuse late callback publication and prove no stale connected row or refresh replay.

## Configured public-origin TLS termination boundary

The mounted /mcp/gateway/* server adapter accounts for HTTPS terminating at a
configured public proxy while Bun receives plaintext HTTP. It rewrites ONLY an
inbound HTTP URL whose normalized URL.host exactly equals the configured HTTPS
public host and whose Host header independently normalizes to that same public
authority. Userinfo, wrong hosts and wrong ports are rejected. The canonical
Request retains path/query, method, body, signal and headers. Normal HTTPS inputs
are unchanged. No X-Forwarded-Host, X-Forwarded-Proto or Forwarded value is trusted.
This is deployment configuration, not a user-selected target or relaxed upstream
endpoint policy. The standalone gateway's strict URL/browser-Origin checks are
unchanged and still run; a wrong browser Origin remains forbidden. A valid public
anonymous ingress receives a scoped-bearer 401 challenge, not an origin 403.

The integration regression uses a REAL local Bun HTTP server with public Host,
real SQL lease/binding authorization and an independent SDK MCP upstream. SDK
initialize/tool traffic crosses that plaintext proxy leg and reaches the upstream.
Wrong host/port, userinfo, browser-Origin and forwarded spoofing are denied; path
and repeated query encoding are preserved. Passing the original uncanonicalized
HTTP request to the standalone gateway demonstrably reproduces SDK POST 403.
No native VM config or SDK options were rewritten for this network repair.

## Same-boot Boat restore regression

`mcp-before-resume.test.ts` drives the actual Boat SDK/provider against its HTTP
boundary, real migrated SQL, real SDK discovery, and the production native config
writer. The boot ID remains constant. It covers platform autoarchive with no SQL
stop, concurrent replica fences incrementing once, old leases invalid before the
resume HTTP operation, an ambiguous resume outcome followed by a ready retry,
fresh installed gateway credentials, stable parallel ready turns, private/admin
and wrong-org denial, and persisted stopped_at cleared before a known-stop turn.
This local boundary proof is not a claim of executing the operator's managed
Boat native/model probe; the coordinator runs that separately.

## Codex live MCP reload (supersedes the header-injection-only approach)

Pinned Codex 0.167.0 exposes the supported JSON-RPC request
`config/mcpServer/reload` with null/absent params. Official documentation:
https://learn.chatgpt.com/docs/app-server . Pinned source ownership is
`codex-rs/app-server/src/request_processors/mcp_processor.rs` and
`codex-rs/app-server/src/mcp_refresh.rs` in openai/codex tag rust-v0.167.0.
It queues configuration refresh for loaded threads without restarting the
app-server. Merely supplying new headers to an already loaded thread/resume does
NOT refresh that thread's existing MCP client, as the real negative control proves.

The bridge reads ONLY private-known managed entries from current native TOML on
thread/start, thread/resume AND turn/start (Boat can reuse an already loaded
thread without sending resume). If the managed configuration changed, it sends
the supported reload request over private stdin and waits up to ten seconds for
its acknowledgement BEFORE admitting the next request. Unchanged generations
cause no reload. No managed header is injected into per-thread config from the first start onward.
An explicit inline override colliding with a private-known Armada-owned server
name is refused with a narrow sanitized -32602 error directing the caller to a
new disk-inherited native session; no customer header is silently deleted.
Unmanaged config (including customer HTTP headers), original IDs, model settings
and cwd semantics are preserved unchanged. This unshipped feature needs no
migration of legacy 5f sessions; it does not claim to repair an already loaded
legacy session's shadowing overrides.

This is now a transparent duplex bridge. Only its unpredictable, privately owned
reload responses are consumed. All other native stdout responses/notifications
and stderr pass through. Pending reload tombstones are bounded to 128; late
control replies stay private. Invalid config, refused reload or timeout produces
a sanitized error for that request, not an app-server kill/restart. Other threads
continue. No gateway header enters exec argv or control-request params.

`mcp-codex-bridge.test.ts` now proves actual native behavior, not just file effects:
with one unchanged Rust native PID and one persisted thread ID, real app-server
RPC tools succeed initially, after rotated credentials + thread/resume, and after
another rotation with turn/start ONLY. A second real loaded thread remains loaded
and successfully calls its own tools across every rotation: six successful native
tool calls total, with both loaded thread IDs surviving refresh and removal. The real SDK HTTP server issues sessions
bound to the credential epoch and rejects stale session reuse. At least three
fresh authenticated sessions are created; removing the server then refuses tool
admission. No model service or credentials are used: a local failed/interruptible
turn against loopback port 1 only creates the genuine rollout required by resume.
The companion protocol-consumer test separately owns private reply filtering,
peer notification/response preservation and fail-closed per-request errors.

Executable Linux offline check (use the preserved REAL native entrypoint, not an
already managed wrapper, to avoid nesting a legacy bridge):

```
CODEX_NATIVE_TEST_BINARY="$(pwd)/packages/agent-runtime/dist/codex" bun test \
  packages/mcp-server/test/mcp-codex-bridge.test.ts \
  packages/provider-boat/test/native-cwd.test.ts
```

On this worker the nominal `/usr/local/bin/codex` already had a legacy bridge;
source/metadata inspection found it, and the scoped fixture uses its preserved
native executable. No active VM config or installed native executable was modified.
The current opt-in run has six passes. Restoring the pre-fix bridge reproduces
native resumed-tool HTTP 403, with the safe boolean `upstreamRejectedStale=true`.
The fixed native test also proves unchanged executable PIDs, fresh bridge ancestry,
installed-native executable inode match, and no nested/legacy injection bridge.
This offline native result is NOT a claim that the coordinator's managed model
first/stop/resume acceptance has passed; that remains the external live gate.

Private managed-process receipt:
`python3 scripts/mcp/inspect-codex-wrapper.py NATIVE_PID` (run inside the controlled
VM, or deliver the script on pinned private SSH stdin). Output is booleans only:
actual app-server found, installed-binary executable inode match, current wrapper
path metadata, fresh/legacy/nested bridge ancestry, and inspection completeness.
It reads selected kernel argv/metadata, never environments, auth/config values or
history; it never prints argv, PIDs, headers or hashes. A current wrapper symlink
alone does NOT prove an already-running native process uses that wrapper.

For the controlled gateway probe, record ONLY these booleans: incoming bearer
matches pre-restore lease; matches current lease; current SQL lease valid;
lease generation equals sandbox generation; MCP session header present. Compute
comparisons privately and discard raw credentials/hashes. Stale bearer versus
current bearer + stale lease-bound session are distinct failure modes. Do not
weaken either fence to make a probe pass.

Coordinator merge: preserve main's current provider/launch/cwd hooks and the
separately owned Mac sudo-fixture repair. This phase changes the native bridge,
its regression test and the new private inspection helper, not runtime/Modal,
gateway, SQL migrations or beforeResume authority.

## Delayed stopped-observation race

`beforeResume` no longer treats the adapter's earlier stopped GET as current
physical authority. Under current membership and authorized sandbox row locks,
it performs a fresh provider GET (Boat bounds this HTTP read to ten seconds).
If another replica has already resumed/reconfigured, it returns `shouldResume=false`
without fencing. Otherwise it fences only a freshly observed stopped VM. The
row lock serializes this observation/fence against bootstrap configuration
publication. Starting/ready/running observations skip resume; other states fail
closed. No configuration/runtime operation is performed inside this hook.

The production port `createMcpHttpIntegration(...).beforeResume(provider,id,actor)`
now returns `Promise<boolean>`. The server factory MUST return that boolean to
`BoatProviderOptions.beforeResume`, also `Promise<boolean>`: false skips the
resume API, then the adapter re-GETs/waits for readiness and runs beforePrompt.
Skipping the actual API matters: a stale stopped sample must not authorize a
new unfenced resume if the provider stops again after the fresh-ready check.
Missing hooks retain standalone provider behavior; this decision is not a caller
JSON flag. Existing same-boot fencing, ambiguous-network retry and authorization
checks are retained.

The scheduled SQL/provider regression pauses B after its first stopped GET,
lets A fence, resume, install fresh config and submit its native turn, then
releases B. It asserts old-lease denial, continued A-lease validity, one generation
increment, stable installed headers/writes, and no second resume API. The fake
Boat HTTP boundary also implements the real already-ready 409 path. Removing
the fresh physical check reproduces the reviewed bug: expected generation 3,
received 4. All barriers are deterministic promises, not wall-clock sleeps.

## Parallel first native wrapper installation

The root installer holds a per-executable `${path}.armada-install.lock` using
Linux util-linux `flock -x -w 30` on fd 9. The bounded lock is acquired BEFORE
checking/preserving the original and remains held across cwd metadata changes,
wrapper publication and atomic executable-symlink replacement. The lock file is
persistent, empty metadata (never credentials); it is not unlinked on completion,
which would split lock inodes across contenders. Process exit releases the lock.
Missing flock or lock timeout refuses the prompt instead of pretending install
succeeded. Codex and Claude have independent locks; no native app-server/thread
is killed, restarted or held behind an installation lock for its model turn.

Original preservation uses no-clobber mv and also treats a broken original
symlink as existing rather than overwriting it. A preserved original resolving
to Armada's wrapper is refused. The wrapper is prepared under a private temp
name and its entrypoint symlink is published with Linux coreutils atomic rename.
These are VM-side Linux primitives, not assumptions about the operator's Mac.

`native-install-race.test.ts` runs two actual installer processes against owned
temporary executable paths. A waits just before its original-preservation mv;
B either blocks on real flock (fixed) or reaches its own stale absent-original
mv (old). A publishes before B is released. The original symlink must still
point at the real native executable and the resulting wrapper must run it.
The pre-fix negative control deterministically preserved `codex.armada-wrapper`
instead of the original executable, reproducing persistent recursion. No sleeps,
root /usr paths, public test seams or global app-server restarts are involved.
The new concurrency test is Linux-only; this phase does not edit the separately
owned Mac sudo-fixture repair or existing native-cwd tests.

### Exact owned dotted override paths

The private inline-override guard matches the pinned Codex CLI path semantics:
each `params.config` key is split on literal dots. It refuses an exact owned
server segment in `mcp_servers.<owned>` and every descendant (including
`.http_headers`, `.http_headers.Authorization` and `.enabled`), as well as the
nested `mcp_servers: {<owned>: ...}` representation. A scalar/array/null replacing
the entire MCP table is refused when known owned names exist. No override is
stripped or rewritten. An unrelated config key, an unmanaged dotted server, or
an `armada_remote_suffix` server does not match `armada_remote` and remains
unchanged, including customer headers. Ownership is the private exact-name
manifest, never a blanket `armada_` prefix rule.

The protocol subprocess regression now table-tests nested/whole-server/dotted
header/leaf/enabled/whole-table-null refusal across start/resume/turn, then proves
the same child still accepts unchanged unmanaged configuration. Restoring the
old nested-only guard reproduces an admitted dotted override instead of -32602.
The actual same-PID/same-thread native test (second live thread, customer headers,
rotation, session fencing and removal) remains green. This narrow phase ran six
native opt-in tests plus typecheck, lint (existing warnings) and both binary builds
on Bun 1.4.2; it did not rerun the full suite after this final dotted-path change.


### Explicit native executable identity for checkout fixtures

The private inspector accepts an optional metadata-only identity argument:

```
python3 scripts/mcp/inspect-codex-wrapper.py NATIVE_PID \
  --expected-native-binary /path/to/pinned/native/codex
```

When supplied, only that resolved executable's device/inode can match the selected
native child. It replaces, rather than supplements, the managed-VM default
candidate set. With no flag, the existing fixed installed-package globs remain
unchanged. Invalid paths/non-executable files fail the boolean receipt closed.
No path, inode, argv, environment, credentials or history is printed; selected
PID subtree and ancestry bounds are unchanged.

The native regression supplies the resolved fixture `codex.armada-original`
REAL native executable (not a JS launcher) as expected identity. The environment
flag can point at a checkout-relative executable for this test; Node resolves
it before creating the fixture symlink. Combined test commands should use the
absolute checkout path, as shown above, for older separately owned cwd fixtures.
An intentionally wrong executable (`/usr/bin/python3`) must produce false even
while native discovery succeeds, preserving the strength of the inode oracle.

This narrow fix was validated on Bun 1.4.2 with a public pinned Codex 0.167.0
executable copied into an owned /tmp directory: its inode was proven different
from the installed package binary. All six native opt-in checks passed with the
absolute copied path, and both bridge tests passed with its checkout-relative
path. Restoring the old glob-only inspector reproduces the reported inode
assertion with `upstreamRejectedStale=false`; the new explicit identity passes.
Typecheck and lint passed (existing lint warnings); no full-suite rerun, model
inference or cloud resources were used for this inspection-only fix.

The coordinator reports that both real-model Boat first/restore proofs and
cleanup now pass. This phase does not change that native cache protocol, leases,
wrapper, runtime or providers: it fixes only operator inspection and its fixture
identity contract. Preserve the coordinator's Mac test-helper overlay via
three-way merge of the narrow delta.
