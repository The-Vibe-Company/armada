# Modal: enrolled harness lifecycle (#1421)

This is a coordinator-owned, **billable staging check**, not a worker task or a
production cutover. It creates exactly one Modal sandbox, never retries an
allocation, proves a model answer and same-conversation recall through the common
runtime archive, performs an acknowledged checkpoint, and requests compute stop
once. The `--resume` extension activates that same logical sandbox once from its
retained filesystem image, proves a new-epoch same-conversation recall, then
checkpoints and stops it again. Optional `--github`, `--mcp`, `--skills`, `--variables` and `--usage` add the scoped
checks below; they do not claim full harness/setup parity. Configured repository refresh and init scripts run through epoch-bound private
runtime commands before skills, MCP publication and the first prompt.
The existing Modal tunnel path remains the default.

## Prerequisites

Deploy the matching server/runtime revision and current schema through the normal
staging deployment process. The worker does not apply migrations or deploy.
The server image publishes the compiled artifact and manifest automatically;
there is no manual artifact-publication step.

Coordinator staging configuration:

- `ARMADA_MODAL_DIALOUT=1` explicitly enables this staging-only launch route.
- `ARMADA_MODAL_RUNTIME_MANIFEST=/opt/armada/runtime-manifests/x64.json` selects
  the manifest from that deployed build for the Modal Linux x64 target.
- Existing authorized Modal management credentials and immutable workspace,
  environment and App binding, with an existing snapshotted Modal golden.
- An authorized Codex API-key/custom-endpoint account, or an existing server-owned
  Codex subscription account enrolled in the shared model-auth broker.

In the coordinator's secure environment, supply:

- `ARMADA_URL`: the staging **armada-server HTTPS origin**, not the dashboard.
- `ARMADA_TOKEN`: existing authorized Armada bearer, never in argv or logs.
- `ARMADA_RUNTIME_ORG`: the staging organization selection.
- `ARMADA_RUNTIME_GOLDEN`: the existing Modal golden name.
- `ARMADA_RUNTIME_CREDENTIAL_ID`: the authorized Codex model-account UUID.
- Optional `ARMADA_RUNTIME_MODEL`: an account-supported model.

## Single coordinator check

```sh
ARMADA_RUNTIME_SMOKE=one_real_modal_launch bun scripts/check-modal-runtime.ts --resume
```

The script preflights `launch/options.modalRuntime {version:1,enabled:true,followupVersion:1}`
before allocating. With `--resume`, it also requires `resumeVersion:1`; an old
server refuses before any allocation. Omit `--resume` only to run the original
first-answer/follow-up/checkpoint/stop subset. It sends one `sandbox/launch-modal-runtime-v1` request with
`runtimeVersion:1`, `runtimeTransport:"dialout"`, `provider:"modal"`,
`harness:"codex"` and a 900-second TTL. Without `--skills`, skills are empty
and defaults are skipped. With `--skills`, both fields are omitted so the normal
server policy resolves defaults. Connections are empty unless `--mcp` explicitly
selects one existing connection. The golden repositories are refreshed and configured init commands run before inference. The first prompt stores a random
memory token and asks for a separate literal
nonce answer, without tools or file changes. After verifying that archived first
answer, the script sends exactly one follow-up on the same conversation asking
for the remembered token **without repeating it in the follow-up prompt**.
The follow-up request UUID is printed before dispatch. A lost/uncertain response
is not retried; reconcile that same request UUID.

Success requires all of:

1. The launch receipt identifies the Modal sandbox, immutable `dialout` route,
   `runtime.kind:"armada"`, current epoch and prompt ID.
2. `logs/read` identifies `source:"armada-runtime"` and contains that prompt's
   non-partial, non-retracted main assistant nonce answer plus a finished event.
   Tool-result text, another prompt, Modal native ingest or selection metadata
   alone cannot pass.
3. The one `sandbox/send` receipt identifies its original request UUID, a new
   prompt ID, the same conversation and current epoch. The archive must contain
   that follow-up prompt’s exact recalled token and finished event. An old
   answer, another prompt, wrong epoch/conversation or reused prompt ID fails.
4. `sandbox/checkpoint-runtime-v1` returns the same epoch and request ID with a
   complete, nonnegative watermark equal to the durable acknowledged sequence.
5. The one stop request is followed by confirmed stopped metadata. Stop is also
   attempted after inference/follow-up/checkpoint failure when the sandbox ID
   is known.

Expected output: a JSON receipt with sandbox/prompt IDs, epoch, archive source,
`answer:"verified"`, `followup:"verified"`, `checkpoint:"verified"`, both prompt
IDs and the conversation ID, then a compute-stopped message.
No response text or model/provider credentials are printed.

If launch transport fails or its receipt omits the sandbox ID, allocation outcome
is unknown: **inspect existing allocations before doing anything that retries**.
The script does not create a replacement. If cleanup is unconfirmed, inspect the
reported sandbox immediately. A known first failure is not a reason to skip
cleanup, and cleanup alone is not evidence of resume or disk preservation.

## Retained stop/resume proof (`--resume`)

After the first confirmed stop, the script re-reads the **same checkpoint request
UUID** and requires its original epoch/watermark/ACK, then re-reads both original
answers from the common archive while compute remains stopped. It dispatches one
`sandbox/resume-runtime-v1` using a fresh printed request UUID, the original
conversation ID and a recall prompt that does not contain the memory nonce.
There is no allocation or activation retry.

The resume receipt must identify that UUID, `resumed:true`, a new prompt ID,
the same conversation, **epoch exactly previous + 1**, and the exact source
checkpoint epoch/watermark. The resumed prompt must return the remembered nonce
and finished event through `source:"armada-runtime"`; both old prompt answers
must still be readable. A second acknowledged checkpoint then precedes the second
and final stop. Final output adds `resume:"verified"` only after cleanup is
confirmed. Exactly one logical allocation, one resume activation, three prompts,
two new checkpoint intents (plus the stopped readback), and two stops are expected.

The server's resume acknowledgement is gated on actual native-session restore
attestation: its new runtime must read the retained journal and original Codex
session from the SDK filesystem image before admitting the same conversation.
An epoch number or host-ready metadata alone is not this proof. The recalled
nonce supplies real model continuity evidence; the source-checkpoint checks tie
it to the retained disk rather than a new logical sandbox.

If the resume response is lost or invalid, its known sandbox may nevertheless
have activated. The script dispatches the second cleanup stop **once**, without
retrying resume, then fails with the original request UUID available for
reconciliation. If the stopped readback/history fails before resume dispatch,
there is no second activation or unnecessary second stop. No new inputs or
staging secrets are needed for this extension. Workers do not run this check.

Record the exact server revision, receipt and observed result on #1421's parity
table. Local fixtures and green CI are not real Modal inference evidence. Do not
flip defaults or delete the tunnel path until the later parity and cutover gates.

## GitHub delivery (`--github`)

Reuse the existing staging `ARMADA_RUNTIME_GITHUB_REPOSITORY=owner/repo` input
and connected GitHub account/App, with that repository in the selected Modal
golden's recipe. No new credentials are requested. The script resolves the
selected visible Modal golden's organization, preflights repository access and
requires an explicit `provider:"modal"` receipt **before allocation**. Old servers
or ambiguous same-name provider goldens refuse rather than preflighting Boat.

```sh
ARMADA_RUNTIME_SMOKE=one_real_modal_launch bun scripts/check-modal-runtime.ts --github --resume
```

Still ONE allocation, ONE restore activation and TWO stops. Before the initial
follow-up it delivers GitHub configuration via the existing common private RPC.
The follow-up must actually run `gh api repos/<repository> --jq .full_name`:
archived successful command provenance AND current-epoch broker acquisition count
with the same delivered revision are required. A literal answer or a configured
receipt alone is not proof. After restore, the old configuration must be absent;
a new revision is delivered and a fourth same-conversation prompt proves a fresh
current-epoch acquisition. No token/capability is printed or archived. This flag alone does not pull/init the golden, enable variables, or
authorize cutover. Add `--skills` for existing defaults and `--mcp` below to verify the selected remote tool in the
same allocation.


## Automatic remote MCP delivery (`--mcp`)

Reuse the existing Boat coordinator inputs; do not create new credentials or
supply skill references:

- `ARMADA_RUNTIME_MCP_CONNECTION_ID`: existing connected remote MCP connection UUID.
- `ARMADA_RUNTIME_MCP_TOOL`: a read-only tool on that connection.
- `ARMADA_RUNTIME_MCP_ARGS_JSON`: non-secret JSON object arguments (defaults to `{}`).
- `ARMADA_RUNTIME_MCP_EXPECT`: a non-secret expected substring from its successful result.

The selected connection must be visible to the staging owner/organization and use
HTTP or SSE transport. Pinned stdio connections are not supported by this slice.
Before allocation, `launch/options.modalRuntime.mcpVersion` must be `2`, the
script resolves the selected Modal golden's organization once (shared with
GitHub preflight), and `sandbox/mcp-preflight-v1` must accept the one connection.
The launch names it explicitly in `connections:[<UUID>]`; it does not rely on
another user's defaults. **There is no manual MCP configuration call:** the
server delivers the current selection and current-epoch leases privately before
launch, follow-up and resumed turns.

### Single combined coordinator check

```sh
ARMADA_RUNTIME_SMOKE=one_real_modal_launch bun scripts/check-modal-runtime.ts --usage --variables --skills --mcp --github --resume
```

ONE logical allocation, ONE resume activation, FOUR prompts and TWO stops remain.
Omit `--github` if only testing MCP/resume: that uses three prompts and the same
allocation/activation/stops. No extra staging secrets or skill inputs are needed.

Every tested prompt (initial answer, initial follow-up, first resumed answer and
GitHub's extra post-resume follow-up when enabled) must contain actual archived
MCP tool provenance: exact server `armada_<connection UUID with underscores>`,
exact tool name, canonical-equal JSON arguments, successful result and the
expected non-secret substring. This provenance is the common `ToolCall.server`
field, not an assistant's text naming a server. Nested/retracted evidence, another
prompt's tool, a missing/error result, a shell substitute or an old prompt replay
after resume cannot pass. First/stopped history is re-read without reusing a
cached evidence flag. The archive must also contain each prompt's exact assistant
answer and finished event, and the epoch/checkpoint/stop proofs remain unchanged.

Initial receipts add `mcp:"verified"`; final successful resumed cleanup adds
`mcpAfterResume:"verified"`. This proves the selected remote tool and automatic
new-epoch delivery, not all MCP server types or default-selection policies. Record
the exact revision and result on #1421. Workers do not run billable staging checks.


## Existing default skills (`--skills`)

Use the **same combined command above** with `--skills`. It requires no new skill
references, SKILL.md substrings, keys or staging inputs. Do not configure defaults
for the smoke: the check must prove the existing selected Modal golden,
organization and personal policy. The golden is resolved once together with the
MCP/GitHub preflight; `launch/options.modalRuntime.skillsVersion` must be `1`.

Before any allocation, the script uses the existing `readDefaultPins` oracle from
`scripts/default-skill-smoke.ts`: `skills/defaults/get` for the selected golden,
organization and personal scope, with independent same-slug precedence. If the
effective list is empty it plainly reports **“No default skills configured … no
launch attempted”** and allocates nothing. It never creates or changes defaults.

The launch omits **both** `skills` and `skipSkillDefaults`, allowing Armada's
normal policy to choose all and only those effective exact pins. Its golden ID
must match the preflight golden. `verifyDefaultReceipts` then compares launch
receipts with `sandbox/status.skills`: exact references and versions, valid
matching skill IDs, checksums and origins. This is checked at launch, after the
first confirmed stop, after resume and after the second confirmed stop. Missing,
extra, changed or foreign-golden receipts fail; a successful model answer cannot
mask them.

The first receipt adds `skills:"verified"`; successful resumed cleanup adds
`skillsAfterResume:"verified"`. The combined check still uses ONE logical
allocation, ONE resume activation, FOUR prompts and TWO stops. MCP/GitHub tool
and current-epoch proofs are unchanged. It proves the public/private defaults
actually configured by the existing policy; it does not claim coverage of a kind
absent from that policy, nor does it ask the coordinator to supply a skill pin.
Workers do not run the billable staging check.


## Frozen readable template variables (`--variables`)

The combined command above can also prove the template's readable environment on
every tested prompt, before and after the retained stop/resume. Supply one new
**non-secret selector**, `ARMADA_RUNTIME_TEMPLATE_ID`, identifying an **existing
published Modal Codex template** in the selected golden's organization. Do not
create/publish a template or change variables/defaults for this check. No raw
values, variable references, secret bindings or new credentials are requested.

Before allocation the server must advertise `variablesVersion:1`. The check
resolves the authorized Modal golden once, reads the existing `templates/get`
revision and requires:

- The selected golden, Modal provider and Codex harness.
- At least one distinct, valid uppercase readable binding; no application secrets.
- A pinned model account matching `ARMADA_RUNTIME_CREDENTIAL_ID`.
- Empty explicit template skills (existing effective defaults are checked with
  `--skills`), and connections exactly matching the selected MCP connection or
  empty when `--mcp` is absent.
- If `ARMADA_RUNTIME_MODEL` is supplied, it matches the published model.

It pins the returned immutable revision and calls the **existing** experimental
Modal route with standard template `id`, `revision`, `requestKey`, organization
and prompt/TTL fields. It omits direct-golden/account/model/connection overrides.
This reuses the standard template source; it is not another runtime or a new API
route. The non-secret request key is printed before dispatch for reconciliation.
The standard template receipt must be succeeded and match template/revision,
request key, golden, account and definition identity. Its frozen readable values
must have exactly the published keys and pass `validateReadableVariables`.
The script locally normalizes this ordinary template receipt for its existing
checks; it does not change the server's template response shape or infer an epoch
from mutable metadata.

For each tested prompt, the model must run one fixed `node -e` program that reads
only the sorted known readable keys, builds their JSON map, and writes SHA256.
Unset keys become JSON `null`, distinct from configured empty strings. The local
expected digest is computed **only from the frozen launch manifest**, never from
mutable variable APIs. **Neither values nor expected digest appear in prompts or
console output.** Only non-secret key metadata appears in the command; the actual
tool's opaque digest is archived as the evidence under test.

A successful archived `commandExecution` must identify that exact program (or an
exact, correctly quoted Bash/sh login-shell wrapper) and return the expected
digest. Assistant text, another prompt's result, missing environment, a wrong
hash, an echo-masking command or pre-resume tool replay cannot pass. Existing
GitHub command matching remains equally strict. The ordinary nonce answer,
MCP tool provenance, GitHub acquisition, skill receipts, checkpoint and stop
proofs are still independently required when their flags are enabled.

The full combined command remains ONE logical allocation, ONE resume activation,
FOUR prompts and TWO stops. Final receipts add `variables:"verified"` and
`variablesAfterResume:"verified"` without printing values or digests. This proves
frozen readable delivery and continuity, **not application-secret parity**.
Workers do not run this billable check or mutate staging configuration.


## Archived harness usage and frozen cost admission (`--usage`)

The same combined command above adds usage/cost evidence with **no new inputs**.
`launch/options.modalRuntime.usageVersion` must be `1` before allocation. The
script uses the existing `createRuntimeUsageCheck` oracle from
`scripts/runtime-usage-smoke.ts`; it adds no pricing path or token/money formula.

Every page from the verified `source:"armada-runtime"` archive contributes its
`armada/turnUsage` facts before prompt filtering, including facts belonging to an
older prompt on the same page. Each tested prompt must have its own harness
observation as well as the assistant answer, finished event and enabled tool
proofs. A usage event arriving after the terminal event is polled normally rather
than mistaken for absent usage.

After each prompt verification, `sandbox/status.usage` must match all observed
prompt IDs, harness models and counters. Per-turn pricing must identify the
selected account/version and frozen server admission (capture, pricing basis and
rate snapshot), remain unchanged through replay and resume, and agree with the
aggregate. Guest event money is not pricing authority. Missing counters must stay
unknown rather than becoming zero. Successful first/final stops recheck the same
aggregate; a failed launch with no usage evidence does not trigger a secondary
usage check that masks the original error or cleanup uncertainty.

An honestly unknown cost is a valid observation when its admitted provenance and
reason are present: for example Codex may omit cache-write tokens. The check does
**not** turn that omission into a known USD amount or call a known subtotal a
complete price. Receipts add `usage:"verified"`/`usageAfterResume:"verified"`,
`usageProof` with token totals and frozen admission, and final
`costAfterResume:"priced"` or `"unknown"` as actually supported by the evidence.

The combined variables/skills/MCP/GitHub/resume command still uses ONE logical
allocation, ONE activation, FOUR prompts and TWO stops. No catalog/account edits,
extra launch, provider compute or credentials are introduced by the offline
fixtures. Record the exact revision and truthful priced/unknown result on #1421;
workers do not execute the billable staging check.

## Enrolled control operations

Opted-in Modal Codex sandboxes expose `steer`, `interrupt` and bounded foreground
`exec` through the same durable runtime commands as Boat. These operations never
call the Modal tunnel. Only the sandbox owner can control the runtime; steering
also revalidates current membership and the pinned account before enqueueing a
restart. Revoked accounts cannot gain another inference turn by steering.
Interrupt remains available to stop a turn after account revocation.

Native Modal launches are unchanged. This control-routing slice does not claim
live Modal steer/interrupt acceptance or enable other harnesses, subscriptions,
workspace preparation, default cutover or tunnel deletion. Those remain #1421
acceptance work for the coordinator-owned staging lifecycle check.


## Codex subscription accounts

Modal enrolled launch and retained resume use the same model-auth ownership
service as Boat and Docker. For an existing server-owned Codex subscription
account, private enrolment carries only the `runtimeSubscription` selection;
access-only material comes from `/api/runtime/model-access`, bound to the live
runtime token, epoch, owner membership and pinned account version. The shared
broker owns refresh. Guest configuration does not receive the refresh token or
server-owned auth.json. Native-auth publication remains the existing sealed,
CAS-controlled path for runtime-owned accounts; no Modal auth adapter is added.

Use the same one-allocation command above with the existing authorized Codex
subscription UUID in `ARMADA_RUNTIME_CREDENTIAL_ID` (and a supported model).
No new credential, account migration, default configuration or manual artifact
publication is performed by the check. Deploy the matching server revision;
there is no new schema migration. Existing native Modal behavior is unchanged.

The lifecycle smoke proves inference and retained-session behavior for the
selected account, not a forced upstream token renewal. Offline boundary tests
exercise access-only delivery, refresh revision, token registration, and refusal
after epoch replacement or membership/pin/stop/ownership changes during refresh.
Live subscription refresh acceptance remains coordinator-owned and is not
claimed by these tests. Workspace setup is described below; OpenCode, default
cutover and tunnel deletion remain separate #1421 work.

## Claude lifecycle extension

Add `--claude` to the same coordinator command to select the enrolled Claude
Agent SDK driver instead of Codex. Use the existing authorized Claude API-key,
Claude OAuth-token or custom Claude endpoint account and a matching Claude model
in `ARMADA_RUNTIME_CREDENTIAL_ID` / `ARMADA_RUNTIME_MODEL`. Do not reuse a Codex
account. The smoke preflights `modalRuntime.claudeVersion:1` before allocation.
For `--variables`, the existing pinned template must select Claude and that same
account; mixed template/request harnesses are rejected before allocation.

```sh
ARMADA_RUNTIME_SMOKE=one_real_modal_launch bun scripts/check-modal-runtime.ts --claude --usage --variables --skills --mcp --github --resume
```

This still creates one sandbox, restores it once, and requires every existing
answer/session/archive/epoch/checkpoint proof. Claude readables go only to the
selected Claude environment, not the unselected Codex driver. No new credential,
configuration mutation, provider runtime, pricing formula or manual artifact
publication is required. The matching schema must include
`20261114013200_modal_runtime_claude.sql` before opting in. Native Modal launches
are unchanged. Live Claude acceptance remains unproven until the coordinator
records the smoke receipt. Codex subscription ownership is described above;
OpenCode remains a later slice. Default cutover and tunnel deletion are not
authorized here.

## Workspace preparation

The enrolled Modal launch now shares Boat's workspace policy: require current
epoch `workspaceVersion:1` health, prepare GitHub before private repository
access, then execute configured repository pulls and init commands in order.
All setup uses the durable `workspaceExec` bridge, never Modal native exec or
the tunnel. Health, GitHub, repository or init failure aborts launch; there is
no fallback to an unprepared checkout or inference. The existing core pull
retry policy, redaction, progress and ten-minute private setup budget are reused.

GitHub authority during `starting` is restricted to immutable dial-out Modal
rows with a live activity lease, live runtime epoch, owner membership and
current repository binding. Expired leases cannot acquire credentials. Frozen
readables are delivered in the private execution environment for init scripts;
model-account secrets remain confined to the selected harness environment.

Use the same coordinator-owned one-allocation lifecycle command. No golden or
configuration mutation, new credentials, schema migration, separate allocation
or manual artifact publication is needed. The selected golden's existing
configured init scripts now actually execute: launch success is not a live
workspace acceptance receipt until the coordinator runs it. Native Modal setup
is unchanged; retained resume does not rerun first-launch setup. OpenCode and
default/cutover/deletion gates remain separate #1421 work.


## OpenCode enrolled lifecycle

Add `--opencode` (mutually exclusive with `--claude`) to select the existing
OpenCode/ACP driver through the same bootstrap, epoch, command and archive
services. Use an existing authorized OpenCode key/custom connection account and
an account-supported model in `ARMADA_RUNTIME_CREDENTIAL_ID` and
`ARMADA_RUNTIME_MODEL`. OpenAI-compatible, Anthropic Messages and Azure Responses
connection projection is reused unchanged; this adds no new account kind or
provider runtime. The smoke requires `modalRuntime.opencodeVersion:1` before
allocation.

```sh
ARMADA_RUNTIME_SMOKE=one_real_modal_launch bun scripts/check-modal-runtime.ts --opencode --usage --skills --resume
```

One allocation and one retained activation still require exact first/follow-up
answers, same native session, fresh resume epoch, retained archive, usage,
checkpoint ACK and both stops. Existing effective skill defaults are selected
only with `--skills`. The driver continues to export/import sanitized native
sessions, not its credential cache/database.

This slice admits normal frozen configuration, GitHub/MCP delivery and runtime
controls for OpenCode through existing shared services. It does **not** claim
live tool-bearing parity. The native shell-proof extension below supports
`--github` and `--variables`; the native MCP extension below adds inventory-checked
`--mcp` proof. ACP titles/results must not be mistaken for
Codex or Claude provenance.

Normal matching schema/server/runtime deployment must include
`20261114020500_modal_runtime_opencode.sql`. Boat does not gain OpenCode admission;
native Modal behavior and the default-off flag are unchanged. No provider
allocation, forced account migration, new secrets, default cutover or tunnel
deletion is authorized. Real OpenCode acceptance awaits coordinator receipts.


## OpenCode native shell proof

`--opencode --github` and `--opencode --variables` now preflight
`opencodeShellProofVersion:1` before allocating. The same check can combine all
existing non-MCP proofs:

```sh
ARMADA_RUNTIME_SMOKE=one_real_modal_launch bun scripts/check-modal-runtime.ts --opencode --usage --variables --skills --github --resume
```

Use an existing eligible published OpenCode template when variables are enabled,
with the same authorized account/model and existing readable bindings. No inputs,
configuration mutations, migrations or extra allocations are introduced.

ACP display titles are not tool identity. The existing native export, already
used for session continuity and usage, emits shell evidence only from new,
completed assistant messages in the selected native session. Loaded history,
foreign message/session bindings, duplicate call IDs, missing/nonzero exit,
timeout and truncated output cannot supply proof. The archived prompt must
contain the exact command and independent output plus its answer/finished event;
a bare display event or model echo is not sufficient.

The metadata contract follows the pinned OpenCode1.19.5
[native shell output](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/tool/shell.ts)
and [native completed tool records](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/session/processor.ts).
This uses the existing archive, not a new ingestion or runtime path. Matching
normal server/runtime artifacts are required; older servers refuse before
allocation. Live acceptance remains coordinator-owned. The native MCP extension below completes
the code-side tool-proof row; cutover and authorized tunnel deletion remain outstanding.


## OpenCode native MCP proof

The combined existing check now supports OpenCode remote MCP:

```sh
ARMADA_RUNTIME_SMOKE=one_real_modal_launch bun scripts/check-modal-runtime.ts --opencode --usage --variables --skills --mcp --github --resume
```

Before allocating, it requires `opencodeMcpProofVersion:1`, the usual authorized
connected remote MCP selection, and its complete SDK-discovered tool inventory.
The inventory comes from the existing bounded/paginated connection probe, not
operator-supplied names or a new gateway route. Exactly one original remote tool
must map to the expected native name: missing tools, duplicate names and native
sanitization collisions (for example `read.counter` versus `read_counter`) refuse
before allocation. The same inventory is rechecked after every verified prompt;
observed changes or lost authorization invalidate acceptance.

The existing native export supplies MCP proof only for new completed assistant
tool records with matching native session/message bindings, unique call IDs,
selected private MCP configuration/revision and bounded untruncated results.
Native tool name, configured server, exact arguments and independent expected
result must match this archived prompt. Loaded history, ACP display-only events,
foreign server/tool/prompt, error states and ambiguous configured server prefixes
do not supply proof. No second ingestion, runtime, provider auth or proxy exists.

This follows the pinned OpenCode1.19.5
[MCP native naming/error contract](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/mcp/catalog.ts)
and [native MCP result conversion](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/session/tools.ts).
Inventories are before/after observations, not an attestation of an adversarial
upstream server’s internal execution. The actual call still uses existing
current-epoch gateway authorization.

Use existing account/template/default-skill/MCP/GitHub inputs. The script changes
no configuration, adds no credentials, and retains one allocation/one activation
and all prior lifecycle proofs. Matching normal server/runtime artifacts are
required; no new migration or manual artifact publication. Coordinator receipts
are still required for live acceptance, ordinary default-path rollout and the
production-day gate before tunnel deletion.
