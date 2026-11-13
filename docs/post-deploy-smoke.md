# Deployed checks

> **Mandatory deployment gate:** Main staging deployments and exact-SHA publishing
> release calls own smoke. No opt-in or deployment-event fallback exists. Release
> requires its staging smoke before production. See [deployment policy](releasing.md#deployment-policy-1547).

`scripts/post-deploy-smoke.ts` allocates **real, billable compute**. It uses only
an Armada bearer token and the deployed server's `/api/v1/` API. It does not
deploy, apply migrations, or contact a provider/database directly.

## Configure staging

The GitHub environment **staging** uses the following exact configuration names.
Set these at environment scope, not to production values:

| Kind | Name | Purpose |
| --- | --- | --- |
| Variable | `ARMADA_ORIGIN` | `https://armada-mcp-staging.up.railway.app`; smoke API origin |
| Secret | `SUPABASE_PROJECT_ID` | Separate staging Supabase project reference; migrations only |
| Secret | `SUPABASE_DB_PASSWORD` | Staging database password; migrations only |
| Secret | `SUPABASE_ACCESS_TOKEN` | Supabase management token authorized for staging; migrations only |
| Secret | `ARMADA_SMOKE_TOKEN` | Staging Armada bearer token; smoke only |
| Secret | `ARMADA_SMOKE_CASES` | JSON array with staging org, golden and model account identifiers; smoke only |

Verify required environment settings before running. Migration credentials are never
passed to the smoke script. Missing settings in legacy diagnostics can no-op; a
skipped/no-op run cannot authorize promotion.

No origin is defaulted. Set only the explicit staging API HTTPS origin (no
path/query/userinfo), never production or the deployment payload's URL. Protect
the staging environment. Smoke actor requires launch/interior/cleanup rights;
provider/model/GitHub connections live in Armada, not workflow credentials.

Example cases (replace placeholders; account IDs are identifiers, not credentials):

```json
[
  {
    "provider": "boat",
    "harness": "claude",
    "org": "<staging-org-id>",
    "golden": "<boat-golden-name>",
    "model": "<available-model>",
    "modelAccountId": "<claude-model-account-id>",
    "repo": "/home/user/armada"
  },
  {
    "provider": "modal",
    "harness": "codex",
    "org": "<staging-org-id>",
    "golden": "<modal-golden-name>",
    "goldenId": "<modal-golden-id>",
    "model": "<available-model>",
    "modelAccountId": "<codex-model-account-id>",
    "repo": "/home/user/armada"
  }
]
```

Each entry is an explicit provider × harness pair; add entries for every pair
you want to cover. Goldens must already exist for their provider and contain a
git checkout with an `origin` remote at `repo`. Configure the user's model
accounts and GitHub connection on staging beforehand. For private repositories,
the token's user must have access. No provider/database credentials belong in
this workflow.

## Run

From a trusted checkout with Bun installed, set environment variables without
putting the token in shell history or command arguments:

```sh
export ARMADA_URL='https://armada-mcp-staging.up.railway.app'
read -rs ARMADA_TOKEN; export ARMADA_TOKEN; echo
export ARMADA_SMOKE_CASES="$(cat /path/to/staging-cases.json)"
export ARMADA_SMOKE=create_real_compute
bun scripts/post-deploy-smoke.ts
unset ARMADA_TOKEN
```

The normal path launches each case, sends one trivial prompt, waits for success,
checks `git status -sb` and `git ls-remote origin HEAD` in the checkout, stops
the sandbox and checks provider state.

### Pair prerequisites

All selected pairs share staging `ARMADA_ORIGIN`, `ARMADA_SMOKE_TOKEN` and
`ARMADA_SMOKE_CASES`; no per-pair GitHub/provider key. Each needs an authorized
model account for its harness, supported model, org UUID, provider-specific golden
and checkout path with origin. `goldenId` names that same golden, not the other
provider's. Optional effort and exact skill pins retain their documented semantics.
Use a separate staging Boat account/key shared by its Claude/Codex cases; Boat's
one-golden account limit does not justify pair-specific extra goldens. Provider/model
keys remain in Armada's vault, never cases or workflow arguments.

The **Post-deploy smoke** workflow is a manual **main-only** entry point to the
same pinned staging deployment-and-smoke workflow used after main merges. It
first deploys the dispatch's main SHA, then smokes that deployment; it no longer
accepts `deployment_status` events. PR, merge-queue (`gh-readonly-queue/*`) and
release-please branch deployments cannot trigger smoke or attach its slow check
to those branches. Dispatch from any other ref is skipped. The publishing Release
workflow remains the only slow gated path: exact release commit staging deploy
and smoke, then production. Main post-merge smoke is not a PR/merge-queue gate.

The manual alias requires all staging deployment secrets and smoke cases; missing
configuration fails before smoke rather than producing a successful no-op
attestation. The old deployment opt-in variables are ignored. Set ARMADA_ORIGIN, ARMADA_SMOKE_TOKEN and ARMADA_SMOKE_CASES
in staging as documented above. Do not restore deployment-event smoke as a
fallback. The pinned deployment and smoke stay serialized together and are not
cancelled by a newer deploy, allowing cleanup to finish.

Each step emits a fixed diagnostic line; failures exit nonzero. API bodies,
command output, tokens and provider error messages are never printed. Requests
and polling are bounded, and cleanup runs even after a failed step. This is
a receipt-scoped smoke, not a fleet-wide resource janitor: a killed runner or an ambiguous create
response can still require operator reconciliation in the staging dashboard.
Do not blindly rerun a timed-out create. Without a deletion journal, stopped resources retain provider disks
according to the normal retention policy; this smoke does not delete goldens or unrelated resources. With a durable journal,
known sandbox rows are deleted only after their stop/recovery assertions (below).

## Offline validation

```sh
bun test scripts/post-deploy-smoke.test.ts
```

Tests drive the real step logic through a fake API and virtual polling clock;
they require no credentials, network calls, compute or wall-clock waits.

### Managed GitHub runtime mode

`bun scripts/post-deploy-smoke.ts --github-runtime` runs the staging-only native
Git/push check. It additionally requires each case's `disposableRepository` field
(an exact credential-free HTTPS GitHub `.git` origin), all four provider/harness
pairs, gate/revision assertions and disposable push authority. See the
[settings, manual renewal and provider-specific broker procedures](github-runtime.md#automated-first-slice-822).
First run the default smoke above with the staging gate off for the stock baseline;
then retire those workers and turn staging on before running the new mode. A zero
exit from this partial check does not authorize production enablement.

### Work preservation

Both staging workflow entrypoints now pass `--work-preservation`. This mode
refuses any origin other than `https://armada-mcp-staging.up.railway.app` before
making requests. The existing case format is unchanged: every selected pair runs
twice, using separate disposable sandboxes. The first must start clean with no
local-only refs and stop without a preservation note or recovery archive. The
second creates a single empty, unpushed commit (no remote push), stops, retrieves
the same recovery endpoint used by `armada recovery`, and checks the in-memory
tar manifest for that exact commit. The selected bundle pack is indexed with Git
in a private temporary object store, then Git must read the expected commit
object. Incremental bundle prerequisite parents/trees need not be present; this
is an object-payload check, not a full checkout/restore. The archive is capped at
3 MiB base64, Git subprocesses at 10 seconds each, and the temporary store is
removed in a finally block. No tar paths are extracted. Archive contents, commit
IDs and Git/provider output are never logged. The smoke runner now requires Git.

Named steps are `preservation_clean_checkout`, `preservation_commit`,
`preservation_clean_stop` and `preservation_archive`. Missing or mismatched
archives fail with `preservation_failed`; the existing stop and cleanup receipts
still confirm provider termination. Recovery is checked after stop/status so a
lifecycle capture overwriting the stop result cannot silently pass.

Budget: two allocations and two trivial model turns per selected pair, instead
of one. Expect roughly 4–10 minutes per pair (provider/model dependent); the
whole run remains capped at 35 minutes plus five minutes reserved for cleanup,
inside the 45-minute workflow limit. Four slow pairs can exhaust this budget and
fail closed. Cost is twice the baseline sandbox/model usage, plus small recovery
storage; stopped disks/archives retain the normal retention cost. No dollar
estimate is reliable without the configured provider/model rates. Do not run
this mode with production credentials. Live staging execution is performed by
the existing post-deploy workflows, not by a PR or offline test run.

### Template and skill pins

The template mode exercises personal readable-variable templates and pinned
public/private skills on the explicitly selected provider × harness cases when
the corresponding exact pins are configured.
A random disposable value must be read by the native
agent (not included in the prompt), while a plain exec must not inherit its
environment binding. Installation receipts must match the requested exact pins.
Private installation is skipped only when Skillpack connection metadata confirms
no personal or matching-org key is configured; a configured but unusable key is
a failure. Template, variable and sandbox cleanup runs even after a failed check.

Both staging entrypoints pass `--templates-skills` in addition to
`--work-preservation`. The new mode also refuses any origin other than the exact
staging API origin before requests. It can be run independently with:

```sh
bun scripts/post-deploy-smoke.ts --templates-skills
```

For this mode every case additionally requires `goldenId`. Optional `publicSkill`
(`org/slug@exact-version`) and `privateSkill` (`slug@exact-version`) enable their
individual install checks. Omit either pin to emit an explicit
`skill_pin_not_configured` SKIP for that step, while the readable-variable template
launch, answer and exec-isolation checks still run. For example,
add `"publicSkill": "your-catalog/public-smoke@1.0.0"` and
`"privateSkill": "your-private-smoke@1.0.0"` to each existing case, using real
accessible pins. There are no default pins; malformed supplied pins fail configuration.
The selected `modelAccountId` is pinned to its current metadata version through
`creds/list`; no silent default-account substitution is used. The existing
`repo` remains the absolute exec cwd, not a template repository selector;
template launches use the golden's default native cwd.

Cases are the explicit enabled provider × harness matrix, as in the baseline.
There is still no ordinary sandbox capabilities API; a configured unsupported
pair fails rather than silently skipping. Keep the staging cases current.
The existing staging token needs readable-variable/template create/delete,
credential metadata, launch, interior access and stop permissions. Provider/model
keys and Skillpack keys remain in Armada's staging store, never in the cases.

Per pair, the first template carries the random variable, with a public pin only
when configured; a second template launch checks a configured private pin if a
key is available. Both the completed launch
manifest and sandbox status must carry matching receipts (reference, exact
version, skill ID, SHA-256 checksum and registry origin). The agent answer must
equal the random value exactly, and plain exec must see the variable as unset.
A private-key skip is a separate structured `skip: true` receipt, not a pass.

Budget: this adds one public and up to one private sandbox/model turn per pair,
roughly 3–8 minutes extra per pair depending on install/provider/model latency.
Combined with work preservation, expect three or four sandbox allocations and
model turns per pair, plus Skillpack install traffic; compute/model charges are
roughly three or four times the original one-worker baseline. The shared
35-minute work deadline and five-minute cleanup reserve are unchanged; slow
matrices fail closed rather than extending the run. Each new sandbox has a
15-minute TTL. Stopped disks and tombstoned metadata use normal retention.

Cleanup attempts every known sandbox, template and variable even if an earlier
cleanup fails. Lost variable/template create responses are reconciled by their
unique random names. An unknown launch response is never retried: without a
cleanup handle the run reports `cleanup_unconfirmed` and requires operator
reconciliation before rerunning. A final `template_cleanup_summary` reports
`leftoverSandboxIds` for failed stops and `uncertainLaunches` with the template
ID/name, exact durable launch request key and returned request ID when available.
These handles survive template deletion; never retry a launch with a new key to
reconcile it. Non-success launch receipts retain allowlisted `state`/`reason`
labels (including Skillpack transport/authorization and allocation uncertainty);
unknown remote text is replaced by `unrecognized_refusal`. This remains a smoke, not a resource janitor.
No live staging run or deployment is implied by the offline API tests.

### Sandbox lifecycle and timings

Both staging entrypoints additionally pass `--lifecycle`. This flag is
independently runnable against the exact staging origin and needs no new case
fields. It reuses the ordinary clean-case worker, not the template worker:
launch → ready → send/wait → idle steer refusal → extend → stop → send/resume →
wait → final stop. The existing dirty preservation worker is not resumed.

Named verdicts include `list_ready`, `steer_refused`, `extend`, `list_stopped`,
`resume_send`, `resume_wait`, `list_resumed`, `stop_resumed` and
`list_stopped_final`. Idle steer must return exactly HTTP 409 /
`no_running_turn`; other errors and accidental admission fail. Extension must
advance the persisted expiry and match the status receipt. List/status checks
compare this worker's ID, harness, provider, status and expiry, with owner/harness/
status filters and bounded pagination (at most 20 × 200 entries).

A named `time_to_ready` pass records milliseconds from immediately before
launch through its ready observation, tagged with provider/harness and case.
Each ordinary worker also emits `lifecycle_cleanup_summary`, with total elapsed
time, known leftover IDs and an explicit unknown-launch flag. An ambiguous
launch cannot be retried or declared clean: use the reported org/golden/start
time to reconcile staging resources before rerunning. No new correlation API is
introduced. Interrupted runners still require operator reconciliation.

This mode adds one tiny model turn and one retained stop/resume physical incarnation
per selected pair, not a new logical sandbox. Expect roughly 1–4 extra minutes
per pair; provider cold-start/model rates determine cost. Extension requests
1860 seconds from now (initial logical TTL 1800), within existing Modal physical
headroom, then cleanup stops compute; no TTL wall-clock wait is added. Shared
35-minute work / five-minute cleanup deadlines and 120-poll bounds remain.
Lifecycle alone is not expiry-as-stop proof; use the expiry check below.

### Personal vault

Both staging entrypoints additionally pass `--vault`. Standalone
`bun scripts/post-deploy-smoke.ts --vault` performs only vault checks, allocating
no sandbox/provider compute. Every selected provider × harness case gets fresh
personal variable/secret names under its staging org UUID. No new case fields,
provider keys, database access or migrations.

Named verdicts cover variable set/list/read, secret set/list metadata-only,
secret read refusal (direct control API400/invalid), rotation v1→v2, stale
rotation409/conflict with unchanged version/epoch, revoke v2→v3, and refused
rotation after revoke with unchanged revoked metadata. These are management/API
checks, not runtime secret delivery or multi-user RLS proofs.

Secret values are random disposable canaries protected before any request.
Success metadata accepts only the shipped metadata columns; responses are checked
for canary echoes. Error envelopes are checked too, before an expected409 can be
accepted. Canaries, readable values, response bodies and exception text are never
printed or written to local files; HTTP bodies are authenticated over HTTPS.
Only owned identifiers/names appear in cleanup summaries.

Finally, reconcile exact owned names/current metadata versions, delete the secret
then variable, and continue cleanup if either fails. Unknown mutations are never
replayed. A known ID is still deleted when a list omits it; an unknown create
with no discoverable ID stays unconfirmed, with its exact random name reported.
`vault_cleanup_summary` lists `leftoverSecrets` / `leftoverVariables`; a lost
delete acknowledgement can be confirmed by read-only absence, without replaying
the write. Normal runs leave only deleted metadata/audit history under ordinary
retention; no active secret/value or compute remains.

Approximately16 small API requests per pair, plus bounded reconciliation reads
on failure; expect seconds per pair, no model/compute charges. The shared
35-minute work deadline and five-minute cleanup reserve apply, with each request
bounded by remaining time. Missing staging personal-vault permissions/encryption
configuration fail closed. The existing smoke token must have personal vault
management rights. No live staging receipt is implied by offline tests.

### Durable recovery handles and repeat reads

The existing `--work-preservation` checks now also verify the durable recovery
reference, not only the latest archive payload. Empty unpushed commits use a
fresh per-worker message marker, so two workers started in the same second
cannot accidentally share the same commit identity.

After Git validates the archive/expected commit, `preservation_recovery_handle`
parses the saved note's sandbox/recovery UUID pair, requires this sandbox, and
fetches that exact `recovery_id`. It must return the same archive as the latest
lookup. `preservation_unknown_handle_refused` probes a fresh absent UUID and
requires null, so an endpoint that ignores the selector cannot falsely pass. `preservation_recovery_read_only` repeats the latest read and confirms
the worker remains physically reported stopped and its preservation note is
unchanged. Clean stops also retain their no-note invariant after recovery reads.
A changing/missing explicit archive or changed note fails closed; no full
checkout/restore is claimed beyond the existing Git pack/object proof.

The earlier stop receipt is invalidated before these verification reads, so any
failure still runs idempotent cleanup rather than trusting potentially stale
state. `preservation_cleanup_summary` reports known leftover IDs or an unknown
launch with org/golden/start time, plus a validated recovery ID when available.
Archive bytes, commit IDs and note/provider text are never logged.

No new allocation, model turn, case field, secret or migration. The dirty worker
adds two bounded archive readbacks, an absent-handle probe and one status observation (up to roughly5.4MiB
extra base64 response data at the existing2MiB raw archive ceiling); the clean
worker adds one status read. Expect seconds of API/storage traffic under the
existing35+5-minute shared deadline. Git's bounded private temporary object store
and finally cleanup are unchanged. Offline tests are not live acceptance receipts.

### Default skill pins

`--default-skills` deliberately requires `--work-preservation`: it reuses that
clean/dirty worker pair and its cleanup inventory, adding no allocation or model
turn. Both staging entrypoints include the flag. Every case requires its existing
org/golden UUIDs; canonical casing is used.

Before any compute, named `default_skills_golden`, `default_skills_org` and
`default_skills_personal` reads fetch the shipped defaults API. The client derives
golden < org < personal precedence by skill slug independently of the server's
merge helper. No defaults are changed: concurrent settings edits can intentionally
fail the probe rather than overwrite someone else's configuration.

The clean launch omits both explicit skills and opt-out, then
`default_skills_receipts` requires exactly the effective pins in both the launch
and persisted status receipts, including matching versions, IDs, checksums and
registry origin. Its returned golden ID must match the queried environment.
The dirty worker supplies `skipSkillDefaults: true` and no explicit pins;
`default_skills_opt_out_receipts` requires empty receipt arrays. This still runs
normal work preservation/recovery checks.

If all defaults are empty, empty receipt evidence is still checked, but delivery
steps emit explicit `no_default_pins_configured` SKIPs instead of claiming a
non-empty install/opt-out proof. Configure real defaults through the existing
settings API/UI when pins are available; no dummy catalogue pin is required.
Nonempty defaults must be installable, including a working key for private pins:
broken configured defaults fail rather than skip. Explicit template-pin probes
opt out of defaults so their separate receipt checks remain isolated.

Cost: three read-only policy calls per pair and two status reads, plus only the
installs already implied by normal defaults. No policy rows, writes, new secrets,
migrations or extra workers. Model/registry latency stays inside the shared
35-minute work +5-minute cleanup deadline; slow or changing policies fail closed.

### Scoped Armada access

`--scoped-access` requires `--work-preservation` and reuses its two workers:
the clean Codex parent uses `sandbox/launch-access-v1` with version1 and
maxActiveChildren1; the dirty no-option control omits access entirely and opts
out of skill defaults. Both staging entrypoints enable it. Current ordinary
access supports Codex only: Claude emits explicit `codex_only` SKIP, not a false
authorization-denial proof. Supported Codex pairs must be enabled on staging
using the existing access configuration; unavailable/misconfigured access fails.

The native parent uses only configured scoped MCP launch/message/read/stop.
No owner CLI token, copied bearer, direct owner HTTP fallback, config/grant read
or new orchestration method. The reserved MCP server's legacy internal name is
unchanged; no separate managed parent is created. The nonsecret armada-tools reference
may be read with the supplied exact read-only cat command.

Named proofs: parent configuration, native turn, actual correlated child launch,
message, nonpartial child assistant answer (not prompt/tool echo), stop and
operation ordering. Launch is idle; message supplies a fresh answer challenge.
Input selection must match the parent's golden/account/version/model. Read
evidence must match the child identity/binding. A no-option control must show no
successful delegated effect and either no tools with a fresh no-access reply,
or the exact authority denial for the valid launch request—not generic failure.
This is a live native control, not a claim that separately supplied user tokens
are banned; backend scope/epoch denial remains covered by its owning tests.

Before parent allocation, snapshot a complete ordinary owner-me/golden inventory.
After the parent is quiesced/stopped, cleanup re-reads bounded logs and inventory.
Only receipt-claimed IDs corroborated as new owned rows can be stopped with the
owner API. Preexisting, parent, unverified and unclaimed IDs are never blindly
stopped. `scoped_cleanup_summary` retains parent/local request key, operation
UUIDs and leftover/unverified/unattributed IDs/uncertainty without raw tool text.
Unknown mutations are never replayed; reconcile reported handles before rerun.
If the parent's stop cannot be confirmed, cleanup still attempts safe known
children but must report an unquiesced producer/future-child uncertainty. A
snapshot taken while a parent remains active is never declared final/clean.

Budget: one additional native parent task per worker and one idle child plus one
tiny child message per supported pair; no extra parent allocations. Parent
polling is capped at300 observations (~5minutes plus bounded request latency),
native child reads at20, logs/inventory at20pages; shared35+5-minute deadline still
wins. Normal cleanup stops all known compute. The shipped delegated launch has
no TTL field: child defaults to4hours (plus existing provider headroom), so a
rare unconfirmed allocation can require immediate operator reconciliation.
Never invent a TTL parameter or repeat launch to discover its outcome.
Use dedicated/exclusive staging smoke actors/cases, clean secretless goldens,
named account UUIDs, and a staging public MCP URL; no production origins/sessions.
No migrations/new credentials/case fields. Offline tests are not live receipts.

### Legacy GitHub repair

Both staging entrypoints add `--github-refresh`, requiring `--lifecycle`
and excluding managed-runtime test modes. It reuses the
ordinary clean worker; no additional allocations or model turns. Readiness is
recorded immediately before the new `github_launch_access` read-only git
probe. This proves origin access before the first model turn or explicit
repair, so a later repair cannot mask broken launch access.

After the existing initial turn and git checks, Boat runs named
`github_refresh_first` and `github_refresh_second` API calls, requiring the
same sandbox ID, connected status and stable owner login. Each is followed by
a read-only `github_refresh_access_first/second` origin-access check. No token,
login, response body, SSH exception or git output is printed. Requests are not
retried: an uncertain repair stays failed and ordinary cleanup still stops the
worker. This is observable idempotency/access continuity, not a claim that
encrypted token bytes never rotate.

**Existing capability limit:** explicit `armada github refresh` is shipped
only for legacy Boat. A staging Boat with the optional managed GitHub runtime
enabled refuses this command and will fail this legacy probe; use a legacy
Boat staging case for it. Modal always refuses the legacy command. Its
`github_refresh_unsupported` step requires the existing503/unavailable
refusal; an accidental success or any other error fails. Its idempotency
delivery proof is visibly skipped as `legacy_boat_only`, not claimed as a
success. Positive Modal/managed-Boat explicit-refresh support would be a new
application capability and is deliberately not implemented under the feature
freeze. Modal still has to pass launch GitHub access and the ordinary git
checks. The legacy refusal is not evidence of broker renewal, and managed
renewal/fault coverage remains in the separate managed-runtime smoke.

Duration/cost: two API repairs and two read-only git checks for Boat, one
refusal for Modal, plus one pre-turn git check per pair. Expect seconds to
roughly two minutes per pair for SSH/auth latency, no extra model usage or
worker. Requests and60-second execs stay under the existing35-minute work /
five-minute cleanup budget. Staging requires the smoke owner's existing GitHub
connection with origin access. Use a private GitHub origin in the existing
checkout to make git access an authentication proof: a public origin only
proves connectivity and cannot demonstrate that a token is installed correctly.
The probe does not infer repository visibility from a successful ls-remote.
No policy/settings writes, migrations,
deployment or production actions. The coordinator runs both providers after
merge; offline tests do not prove real GitHub/SSH success.

### Ordinary expiry-as-stop

Both staging entrypoints add `--expiry`. Standalone
`bun scripts/post-deploy-smoke.ts --expiry` runs only this family.
It is admitted only on the exact staging origin. Combined mode requires
`--lifecycle`, so template-only early returns cannot silently skip the probe;
unsupported combinations are refused.

For every selected pair, launch one additional prompt-free ordinary worker
with a 180-second logical TTL, no connections and default skills opted out.
Named `expiry_launch`, `expiry_ready` and `expiry_deadline` steps check its
identity, readiness, persisted effective TTL and bounded expiry receipt.
The existing paginated sandbox/list API supplies provider/harness, effective
TTL and stop timestamp; sandbox/status supplies the physical state/reason.
List reads filter owner and harness and allow at most20pages of200rows,
matching the known worker ID without assuming undocumented status fields.
`expiry_time_to_ready` records readiness immediately, before waiting for TTL.

`expiry_as_stop` polls status without sending, extending or explicitly stopping
the worker. Success requires logical stopped, the matching physical stopped
state (Boat archived / Modal stopped), unchanged expiry, reason exactly
`expired`, and a stopped timestamp at or after that expiry. Failed workers,
early/manual-looking stops, changed deadlines and provider hard exits without
the expiry reason cannot count as proof.

A failing known worker gets one explicit cleanup-stop attempt plus read-only
reconciliation (never mutation replay). That cleanup cannot convert the expiry
verdict to success. Failed workers retain logical failed status after cleanup;
their finite durable stoppedAt receipt confirms physical exit because the
terminal-failure status projection intentionally hides provider state. A failed
row without that receipt remains unconfirmed. `expiry_cleanup_summary` reports leftover IDs or ambiguous
launches with org/golden/start time. Lost create responses are never retried.
This is not a resource janitor: an interrupted runner or unknown create still
requires operator reconciliation.

Expected added duration: about 3–5 minutes per pair, sequentially; no model
turns, one extra short-lived worker per pair plus normal retained-disk cost.
Each request remains bounded by the existing shared 35-minute work deadline
and five-minute cleanup reserve. Ready polling allows 120 observations,
natural expiry 360, cleanup 120, each separated by one second; slow matrices
can exhaust the shared deadline and fail closed. Staging operators must budget
this extra compute time. No production, new capabilities or migrations.
The coordinator executes both providers after merge; fake transport tests
prove verdicts and cleanup, not real-provider expiry success.

### Golden runtime integrity

Both staging entrypoints enable `--golden-runtime`. On the existing ordinary
worker (only the clean worker when preservation is enabled), named
`golden_helper_integrity` and `golden_skillpack_integrity` steps verify installed
bytes, executable resolution and version/protocol. No extra allocation or model
turn is added. The flag refuses non-staging origins, template-only
combinations without preservation or lifecycle (which would otherwise return
before the ordinary worker checks).

The helper must match the bundled architecture-specific digest and closed
0.1.0/protocol-1 report. Skillpack and skillpack-runtime must match the contents
of the SHA-256-pinned runtime-v0.3.5 release archive used by the golden bootstrap.
The probe downloads that archive to a private temporary directory, verifies its
pin before extraction, compares both installed executables, and removes its
temporary files. It never installs, repairs, or executes downloaded binaries.
The helper bootstrap symlink and the Skillpack command must resolve to the verified bytes;
the helper is not required on PATH (Modal exec intentionally omits user-local bin). missing, stale, altered,
unsupported-architecture or unavailable-download cases fail closed and the
existing worker cleanup still runs. Guest output is not printed.

Prerequisite: staging goldens must contain the shipped helper and Skillpack
runtime (a golden built with the soft Skillpack download warning will fail this
check and needs an operator rebuild). No policy, production or database changes.
Expected added duration: seconds to about one minute per pair; two existing
60-second exec bounds and the shared 35+5-minute run deadline apply. Cost: one
pinned release download per pair plus trivial hashing/exec, with no model usage
or extra worker. Offline transport tests do not prove deployed provider bytes;
the coordinator runs both enabled providers after merge.

## Dashboard read probes (password-free)

Both staging workflows run `bun scripts/dashboard-read-smoke.ts` concurrently
with compute smoke. This uses the **fallback read-level approach** from #1460,
not signed-in HTML. The dashboard authenticates with a Supabase session cookie;
the existing Armada service bearer cannot mint one. No existing smoke credential
authorizes Supabase admin-generated links. We do not provision a password, user,
admin key, or session secret.

Only the existing `ARMADA_URL`, `ARMADA_TOKEN` and `ARMADA_SMOKE_CASES` are needed.
Every distinct case org is checked. Named steps are `dashboard_configuration`,
`dashboard_sandboxes`, `dashboard_otto`, `dashboard_hosts`, and
`dashboard_launch_options`. Each read step has a 15-second bound and reports only
pass, elapsed time and a closed failure code; response bodies and credentials
are never logged. Non-2xx, error states, malformed/skipped rows, incomplete Otto
pagination and slow answers fail, rather than silently disabling a probe.
Otto and Docker host list routes must be enabled on staging.

Sandboxes calls `sandbox/list` and imports the dashboard's own
`parseSandboxListMetadata`, rejecting skipped rows even though the UI tolerates
them. Otto uses the dashboard's `readOtto` (summary, tasks, resources, orphans,
facts and pagination). Hosts and launch options use the same dashboard parsers.
These are read-only API calls; no compute or account is created.

**Uncovered:** actual HTML rendering, hydration, session cookies, selected-org
handling and user-JWT RLS/Supabase RPC paths (including sandbox costs, membership,
goldens and other resource pages). These probes do not claim full dashboard page
coverage or prove that the dashboard's RPC schema matches the control API.

Coordinator check after merge (workers have no staging access): run the staging
smoke and confirm all named steps pass for the existing smoke identity within
the bound. No new credentials should be configured. Offline proof:
`bun test scripts/dashboard-read-smoke.test.ts` injects malformed sandbox rows
through the real parser and confirms only `dashboard_sandboxes` fails, with
siblings finishing. Staging evidence remains the coordinator's responsibility.

## Legacy independent staging migrations

When release-only gates are disabled, the Database migrations workflow may
independently link/list/preview/apply staging migrations on main/manual dispatch.
Manual defaults to dry-run; missing settings can no-op. It does not order schema
before Railway deploy, so additive compatibility is still necessary. All
`SUPABASE_*` settings must identify the separate staging project. Production
promotion/history/repair and authoritative workflow ordering remain in
[releasing](releasing.md) and [database migrations](database-migrations.md), not a
legacy successful no-op or unrelated historical smoke check.

## Targeted staging checks

These supplement automated smoke families, not evidence that they passed. Use
only authorized **disposable staging** resources and synthetic canaries. Workers
do not deploy, apply migrations, alter production or acquire operator secrets.
Product/API contracts live in [templates](templates-cli.md) and [vault](vault-cli.md).

### Vault and template authorization

- As personal owner/peer/admin/outsider and org member/admin, test explicit
  scope, personal invisibility even to admins, shared reads/admin-only writes and
  immediate denial after membership removal. Direct PostgREST must neither expose
  ciphertext nor bypass API writes. Audit/tombstones contain IDs, operation,
  version/outcome/time, never value-derived length/hash/prefix/suffix.
- Test empty variables, multiline/literal shell text, reserved names, NUL/invalid
  Unicode, >8 KiB inputs, empty secrets, stale/concurrent rotation/revoke and
  terminal revoked names. Errors must not echo random canaries. Check omitted
  expiry preserves it, null clears it, both direct and upload/commit. Uploads
  expire after five minutes and reject wrong actor/org/replay. No secret reveal
  API, provider traffic or backup-erasure guarantee follows from vault management.
- Create personal/org templates on each provider with two distinguishable variables
  (one empty), exact tools/model/effort, and accessible public/private skill pins.
  Verify native configuration and manifest/receipt checksums, including idle-first-
  send, stop/restore, new Modal runner and cleared Boat `/run` rehydration. No values
  should enter build/pull/init or unrelated exec **environment**. Boat's 0644 JSON
  file remains intentionally readable to guest users/exec: this is not secrecy.
- Readable source edits/deletion after admission retain frozen manifest values;
  normal independent sandbox/model/tool authorization still applies. Secret
  bindings instead re-resolve exact references with current ownership/version/
  revocation/expiry. Test a random secret through template CLI/dashboard picker:
  agent reports a boolean, never prints it; APIs return references only. Rotate,
  require old-version new/later delivery refusal, republish; revoke and require
  denial. Do not claim previously delivered copies were erased.
- Reject personal refs in org templates, stale account/ref, removed golden,
  disabled tool or remap before allocation. Revoke during init: no hydration or
  first prompt, and confirm stopped compute. Concurrent matching key/body and
  replay after restart/lost response keep one allocation; changed input conflicts.
  Snapshot A in-flight stays A (or refuses if retired); a new key may follow
  rebuilt B without republication. Unknown fork remains reconciling: inspect
  recorded logical/provider IDs and labels, never delete its fence/request or
  submit a fresh key to guess. Frozen results replay unchanged after tombstoning.
- Compare actionable direct/API/CLI/dashboard refusal messages, stale revisions,
  pinned-account override refusal and private busy-holder link visibility. A
  definite refusal can choose an eligible alternate account/new request; uncertain
  allocation cannot. Check both public proxy and MCP operations.

### Raw delivery and the existing taint gate

Template raw-secret environment delivery is enabled by owner decision on Boat and
Modal using ordinary lifecycle/readable transport, including Boat's readable file.
**No taint is added and no secret-safe recovery, retention, snapshot, redaction or
erasure is promised.** Agents/children, same-UID/root, provider-key holders and
publishers can read/exfiltrate plaintext. Transforms, screenshots, files, commits
and network output evade known-value masking; rotate upstream after exposure.

The existing irreversible `application_secret_tainted` marker is a separate first
gate: preservation/recovery, ordinary prompt resume and all ordinary exec refuse
before native hooks. On a deliberately marked disposable Boat sandbox, allow
provider TTL archival while SQL remains ready, then test CLI/MCP/control exec:
no command or compute revival. Running tainted exec also refuses. Stop/delete
must still clean compute with value-free preservation warning. Do not set this
marker on real workloads or infer that template delivery uses it.

This is **not** concurrency-safe hydration or provider-internal recovery fencing.
Provider-internal recovery (including Modal filesystem recovery images) is not
covered by this first gate; it cannot authorize proposed hardening. Keep permanent
exposure history/tombstones in rollback/restore; dropping the marker is unsafe.
Database deletion does not erase backups, provider disks/events or delivered
copies. The broader [hardening design](design/templates-variables-secrets.md)
remains proposed, not a prerequisite silently imposed on owner-approved raw delivery.

### Native Boat stop

Use an ordinary **native** Boat staging sandbox, not the enrolled runtime lane.
Exercise exec/send/wait/logs, then `armada stop ID --json` twice: return stopping/
stopped, not lease conflict or a second physical stop. Status/detail remain readable
while archiving; once Boat confirms archival, list shows stoppedAt. If unconfirmed,
retain retry reason and investigate Boat archival, never infer exit from time or
resume. After completion repeat stop; require one `sandbox_stop_dispatch` for the
successful archival, not repeated dispatch while archiving. Contested observations
return authorized persisted state; pending archival/unconfirmed failed stop cannot
make wait claim the native turn settled.

### Database runtime readiness

`/healthz` uses the existing serving SQL pool's read-only `select 1`. Success is
200/ok/version; failure or two-second observation deadline is503,
`database_unavailable`, no-store and Retry-After5, never raw driver/connection data.
Results cache for one second and share **one** in-flight query. Observation timeout
does not cancel raw SQL or permit another pool/query buildup; late success cannot
publish recovery without a fresh successful observation.

In authorized disposable staging, block serving pooled sockets/queries **after
boot**, not merely new connections. After cache expiry require bounded503,
including concurrent probes without query-per-probe growth. Restore; wait for
old query settlement/cache expiry and require fresh success/200 without restart.
Separately stall a readiness query: stay503 until it settles; late success alone
cannot recover. Capture safe timings/proxy query counts. This is not proof of
writes, migrations, Auth, providers/models. Railway health gates deployment, not
a promise that it continuously restarts running deployments.

## Subject-specific acceptance

Use [runtime validation](runtime-startup.md#validation),
[Boat runtime](boat-runtime-first-prompt.md#staging-acceptance),
[Docker hosts](docker-host-daemon.md), [OpenCode](runtime/opencode-modal.md) and
[Otto](otto-staging.md) for their implemented feature gates and real-provider checks.
Synthetic protocol/build proofs are not inference or production acceptance.

## Sandbox deletion receipts

Both staging workflows upload `.smoke/sandboxes.json` as an artifact even when probes fail, restore the latest named artifact across branches/tags, and set
`ARMADA_SMOKE_JOURNAL` for the compute smoke. Launch receipts are persisted before
probe validation; cleanup deletes known IDs after all stop/recovery assertions.
The bounded startup sweep retries at most 32 older receipted IDs in parallel;
current-run deletion has an independent 64-ID bound. It never lists all stopped
sandboxes for deletion. The target `smoke_cleanup_summary.remainingRows` is zero;
deleted audit rows remain but do not grow active dashboard lists.

For a manual staging run set `ARMADA_SMOKE_JOURNAL` to a durable receipt path.
Without it, the legacy operator smoke retains its stop-only behavior. The removed
`--orchestrator` mode is refused before compute; no compatibility mode is available.
Lost launch responses or forced termination before persistence require coordinator
reconciliation: direct launches have no idempotency lookup. Unknown outcomes
fail the run instead of claiming zero growth. Artifact expiry can lose retry
receipts; preserve `smoke_sandbox_receipt` output as independent audit evidence.

Coordinator checks: compare org counts before/after a normal run; deliberately
fail a probe after launch; restore one known smoke receipt on the next run and
verify its deletion while an unrelated stopped sandbox remains unchanged.

## Historical cleanup plan

1. Recover an explicit ID manifest from trusted smoke execution receipts. Each
   entry is `{ "requestKey": "post-deploy-smoke:<UUID>", "org": "<staging org>",
   "id": "<sandbox UUID>" }`. The key labels the original smoke request in the
   audit manifest; it is **not** a server-side sandbox label. Keep its source run
   URL alongside the manifest. Never manufacture attribution from stopped status,
   age, owner or golden. Old direct launches did not persist labels: without
   trustworthy receipts, stop and request coordinator attribution.
2. Set `ARMADA_URL=https://armada-mcp-staging.up.railway.app`,
   `ARMADA_SMOKE_ORG=<exact staging org from receipts>` and
   `ARMADA_SMOKE_JOURNAL=<manifest path>`. No token is needed for dry-run.
3. Run `bun scripts/cleanup-staging-smoke.ts`. Inspect candidate counts and source
   receipts. Wrong origins (including production) and mixed-org manifests are
   refused before requests.
4. Set `ARMADA_TOKEN` through the staging secret store, then run
   `bun scripts/cleanup-staging-smoke.ts --delete`. At most 32 explicit IDs are
   attempted per invocation. Counts are printed; failures return nonzero. Preserve
   the source manifest and partition into batches of 32. Already-deleted IDs can
   safely be repeated. Never paste tokens into argv or logs.
5. Compare the staging org's visible sandbox count before/after. Run an ordinary
   staging smoke, check all deletion steps and final count zero, then confirm the
   visible count did not grow. No deployment or migration is part of this script.

Offline checks: `bun test scripts/smoke-sandbox-cleanup.test.ts scripts/cleanup-staging-smoke.test.ts`.
Coordinator checks: deliberately fail a probe after launch; restore a journal with
one known leftover on the next run; verify unrelated stopped sandboxes survive.

## Diagnosing and reconciling deletion

`delete_smoke_sandbox` failures now include `phase`, `httpStatus` and a closed,
non-secret `code`. No error message, provider body, bearer or cookie is printed;
unrecognized remote codes become `api_failed`. Retry diagnostics use the named
`delete_smoke_sandbox_retry` step with the same safe fields.

A successful stop request may return `stopping`, not physical completion. Cleanup accepts a matching terminal stop receipt or
observes terminal status before calling the public
`DELETE /api/v1/sandboxes/<id>?org=<org>` endpoint. The former POST alias is also
routed to the same server tool; changing verbs alone is not the fix. A Boat
provider deletion can return pending, which the server reports as `409 conflict`;
that admission intentionally retains a two-minute activity lease, so immediate
retries can return `sandbox_not_ready`. Cleanup now reconciles the same idempotent
delete within a bounded four-minute window, with up to two minutes per HTTP
request instead of 15 seconds. It never replays stop while waiting or deletes a
row merely because it disappeared from a fleet list. Authorization/refusal codes
are reported without retrying indefinitely; failed receipts stay in the journal.

Run 43399781555 discarded all HTTP/error information, so its nine failures cannot
retrospectively distinguish pending deletion, lease contention, authorization or
provider failure. The source confirms the asynchronous-state/lease defects above,
not that every historical refusal had that cause. Coordinator check: restore that
run's exact receipt artifact, run the next staging smoke, require zero remaining
rows, and inspect any named failure's status/code before attributing it. No worker
needs staging access to run the fake-fetch regression tests.
The startup sweep, probe phase and final cleanup share the existing 40-minute
smoke deadline; waiting for deletion does not add a new unbounded grace period.

### Final delegated cleanup order (#1383)

Cleanup uses two waves over its existing exact-ID receipts: ordinary sandboxes
(including delegated parents) first, then `smoke-scoped-*` child receipts. Ordering
is applied before the sweep limit, so a child cannot occupy every bounded slot
while its parent waits behind it. Sandboxes within a wave still run in parallel.

The server permits owner/admin deletion of an ordinary delegated child only
**after its ordinary parent is durably deleted**. Both authorization and atomic
activity admission enforce the same rule. Relation/history rows remain intact;
legacy orchestrator parents and children remain refused. A merely stopped parent
is not sufficient because it could resume and issue delegated work again.

Stop settling and transient `sandbox_not_ready`/pending deletion now share the
full existing five-minute cleanup reserve across both waves, also capped by the
smoke's existing 40-minute deadline. This replaces the previous four-minute
per-row cutoff; it adds no new overall grace period. A still-busy provider or
unsettled lease at the bound remains a named failure with its safe HTTP/code
and a retained receipt, never a falsely successful cleanup.

Coordinator validation: rerun staging with run 43405042771's two exact receipts,
verify parent deletion precedes scoped-child deletion and
`smoke_cleanup_summary.remainingRows` is zero. Confirm unrelated stopped rows
remain untouched. Offline regression tests cover a late-settling stop/lease,
bounded parent-first selection, and real-SQL child-before-parent refusal followed
by successful parent/child deletion under current owner/org authorization.

### Three-provider parity observation (#1532)

Run `bun scripts/post-deploy-smoke.ts --parity` against staging with the usual
`ARMADA_TOKEN`, `ARMADA_SMOKE=create_real_compute`, and `ARMADA_URL` guards.
`ARMADA_SMOKE_CASES` must contain exactly one Boat, Modal and Docker case for a full run.
Use `--parity --only docker --feature exec` to run one provider/feature;
a provider-filtered run may supply only that provider case. Unknown or duplicate
filters are rejected before any request. All
cases supply `org`, `harness`, `model`, and `modelAccountId`. Boat/Modal also
supply `golden`; Docker instead supplies `hostId` (an already registered owned
host) and `image` (the pulled immutable image digest). No SSH, registration,
host startup, preview lifecycle endpoint or provider credentials are used.
The configured host is checked through host discovery; an offline host produces
one explicit `host_offline` diagnostic without preventing Boat/Modal probes.

This is an **additive observation**, not a replacement for any existing deploy
gate or its flags. No workflow/deploy failure policy changes. The command fails
if any advertised operation fails; unsupported operations are reported separately
with the server's `launch/options` reason, never as passes. Dependent operations
that cannot run are failures with a dependency reason, not unsupported claims.
The matrix inventories every requested feature. Implemented probes are
launch/send/status/logs/exec/stop/resume/delete and resume-recall (a random token
remembered before stop and recovered after resume). Exec checks a fixed stdout
marker as well as successful exit. Other rows are explicitly
`not-run: probe_not_implemented`: this is an incremental migration, not proof
that those features work or are unsupported. The older scripts remain until
their checks are migrated. A filtered run still executes launch and cleanup
prerequisites, plus send/stop/resume when recall needs them; these have separate
`prerequisite:*` rows. Nonselected cells remain `not-run`. Unsupported and
not-run counts are printed per provider; only failures make the run nonzero.
There is at most one launch attempt per selected provider, recorded as
`starts` in JSON; stop/resume can allocate additional provider compute.
A full run is not bounded to two minutes; a feature filter skips unrelated
turns, but provider startup time still applies. Client request builders and
cleanup-row reconciliation are follow-up work; do not treat this runner as
evidence those acceptance criteria have passed. The final
`provider_parity` JSON line contains the entire matrix, and the Markdown table is
appended to `GITHUB_STEP_SUMMARY` (or printed locally). Normal sandbox cleanup
journaling via `ARMADA_SMOKE_JOURNAL` remains available; retain that journal after
unknown outcomes for reconciliation. This command creates real staging compute;
a procedure or fake-API test is not evidence of a successful staging run.

#### First staging findings (#1532, 2026-11-13)

Failure cells now include the public API error code, HTTP status, and bounded
credential-redacted server message (never the envelope/details). Local validation
and transport failures have fixed diagnostics. HTTP 429 / explicit quota codes
are `not-run: quota`; dependent cells inherit that diagnostic, not a defect.
No automatic launch retry is made.

Docker's send path sets the persisted machine state to `running`
(`docker-runtime-lifecycle.ts`); status returns that persisted state even after a
prompt finishes. The old Python runner checks host/conversation identity rather
than demanding `ready`. Parity now accepts both live states, with turn completion
proved independently by the logs. The provider field is optional in the shared
status schema; launch already checks provider identity. This is a runner
assertion mismatch, not evidence of a provider regression.

Modal delete was a single attempt here. The adapter can report pending termination
or recovery-image removal; cleanup can retain a two-minute activity lease.
Parity now reconciles the same delete/request ID with a bounded retry, without
replaying stop, and retains the last server diagnostic if confirmation never
arrives. The older Modal runtime script **only stops**, never deletes; its success
does not contradict a delete failure. Because the historical run hid its error,
we cannot assert which server refusal it received; the next staging run will
identify it. No staging result is claimed by these code-level corrections.

#### Parity cleanup receipts and failure paths

Parity uses the same `post-deploy-smoke:<uuid>` journal request-key format as
the other smoke probes. The previous callback key `parity:<uuid>` was
incompatible with `smokeReceipts`. The normal journal wrapper records the launch
first and deduplicates this callback, so this mismatch is not evidence of the
historical `remainingRows:5` cause. It is now safe for receipt consumers that
validate the callback directly. A journal-write error after a known allocation
still requires cleanup, regardless of the callback key.

Every known allocation now has an independent final cleanup attempt, including
journal-write failure and unknown resume outcomes. Cleanup confirms stop before
deleting, reconciles a lost stop acknowledgement by reading status (without
replaying stop), and requires the delete receipt's ID and terminal status.
The table includes a `cleanup` cell and `parity_cleanup` JSON reports the ID and
whether deletion was confirmed. A failed cleanup is a failure even if another
probe was already failed or not-run. Keep the journal for unconfirmed resources;
a lost launch response without an ID still requires operator reconciliation.
The parity probe's shared 35-minute polling deadline still applies; exhausted
budget can leave cleanup unconfirmed. The journal-enabled wrapper additionally
runs its own reserved cleanup phase. This slice does not prove the cause of the
historical five remaining rows or guarantee deletion after provider refusal.
