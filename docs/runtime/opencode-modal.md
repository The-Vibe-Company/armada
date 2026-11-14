# OpenCode on Modal

**OpenCode has runtime launch paths on Modal and owned Docker hosts.** Enabled
placements come from the server's launch options and admission policy, not from
the account's kind. The shared harness catalog drives validators and generated
iOS choices. Codex and Claude
retain their native drivers; OpenCode uses one ACP v1 transport, not a parallel
V2 server/SDK integration. Modal retains its existing authenticated tunnel.

## Connections and launch

A named `opencode` credential is sealed by the existing vault encryption. A
custom connection contains `{endpoint:{version:1,baseUrl,models},apiKey,prices?}`.
`baseUrl` is HTTPS, without URL credentials, query or fragment. Models are exact
upstream IDs. Native IDs use the fixed `armada/` provider prefix. There is no
Armada-hosted proxy. The suggested `deepseek-flash` model ID follows the
[current DeepSeek API catalog](https://api-docs.deepseek.com/quick_start/pricing/);
the retired `deepseek-chat` alias is not a launch default. API keys are stdin/file input only, never CLI arguments.

```sh
armada creds set opencode --name deepseek --base-url https://api.deepseek.com \
  --models deepseek-flash --file /private/deepseek-key
armada creds list --json
armada launch MODAL_GOLDEN --provider modal --agent opencode \
  --credential-id ACCOUNT_UUID --model armada/deepseek-flash \
  --reasoning-effort default 'Reply with exactly: armada-opencode-ok'
```

A raw OpenCode plan/provider key can also be stored as `opencode`; it requires
an explicit native `opencode-go/<model>` (Go) or `opencode/<model>` (pay-as-you-go)
choice. The pinned CLI exposes both provider namespaces with an API key (verified
offline using a throwaway key, without a model request). Official
[Go usage guidance](https://opencode.ai/docs/console/go/#where-can-i-use-it) permits
OpenCode coding-agent traffic; the native CLI owns session headers. Interactive subscription login and
real-plan validation are not implemented or claimed. Never assume plan billing
from a key: without an explicit custom endpoint no public OpenAI price table is
used. Missing costs/counters remain unknown. Optional connection prices use the
existing exact model-price override schema (CLI `--price-*` flags).

The same launch is `POST /api/v1/sandbox/launch` with `harness:"opencode"`,
`provider:"modal"`, golden/org, `credentialId`, `model:"armada/deepseek-flash"`
and `reasoningEffort:"default"`. The server pins the account ID/revision.
Dashboard/iOS harness choices derive from the shared/generated catalog; account
creation in the dashboard supports a raw key, while custom endpoints use the CLI.

## Runtime/artifact and deployment prerequisites (coordinator only)

Deploy the merged harness/credential enum and Modal binding migrations through
the normal authorized process before the matching server/runtime image. Workers
do not apply remote migrations or deploy.

The normal Docker deploy now publishes pinned OpenCode **1.19.5** for both
architectures automatically, verifying native SHA-256 and length during build.
No separate coordinator publication is required. See
[runtime artifact publication](../runtime-startup.md#build-and-publish) for the image's
manifest paths and exact post-deploy HEAD checks. Only selected OpenCode
launches fetch this artifact, and only at start/resume when its verified native
binary/cache is missing. Older goldens need no model key or new native installer
baked into them. Wrong/missing bytes fail closed. No npm/latest fetch happens
inside a prompt and native auto-update is disabled. Native title generation is
disabled: Armada owns names and avoids unreported auxiliary model requests. Credentials arrive separately
in private stdin bootstrap; only the selected driver receives them. `OPENCODE_*`
and the four native `XDG_*_HOME` routing names are reserved readable-variable names so configuration cannot redirect
native credentials/history outside the checkpoint boundary.

Native Task delegation/custom agent modes are not exposed currently:
execution is fixed to build mode with Task denied until child-session graph
checkpointing/metering is implemented. Unexpected child-session exports fail
closed rather than claiming portable continuity. Ordinary read/edit/bash/MCP
tools remain available.

Session exports are redacted/0600, verified by vendor import, and checkpointed; SQLite/auth/config/cache are
excluded. A pending/failed export blocks stale resume and checkpoint rather than
claiming continuity from an older transcript. Restart steering cancels then
continues the same session. Turn tokens sum new native assistant messages from
the verified export, excluding loaded history and normalizing native disjoint
reasoning into Armada's output subset. The ACP response alone describes only the
last model step in this pin. Incomplete native steps/counters make the combined
turn unknown, never an invented partial sum.

## Staging lifecycle check (coordinator-owned real DeepSeek key)

1. Migrate/deploy the artifact-bearing image, create the account and launch as above
   on a Modal golden. Expect an answer and current-turn input/output tokens in
   `armada status ID --json`, without any key in logs/events/exec output.
2. Send a follow-up. Start a tool-bearing prompt, steer it while active, then
   start another and interrupt it. Expect one terminal Armada prompt per turn,
   same conversation identity and no duplicated history. Missing interrupted
   counters may be unknown; ordinary completed turns must report native tokens.
3. Stop/resume/send again. Expect imported native history, a successful answer
   and a new prompt's reported tokens, not a reused cumulative total.
4. Run `ARMADA_SMOKE=create_real_compute bun scripts/post-deploy-smoke.ts --lifecycle`
   with staging `ARMADA_URL`, `ARMADA_TOKEN` and an `ARMADA_SMOKE_CASES` entry
   `{provider:"modal",harness:"opencode",org,golden,model:"armada/deepseek-flash",
   modelAccountId,repo,reasoningEffort:"default"}`. Expect the ordinary lifecycle,
   read-only status/events and confirmed stop/delete checks to pass. No scoped
   Armada child access is enabled for OpenCode on this path.

## ACP and portable state

The pinned `opencode-ai@1.19.5` Linux x64/arm64 native binary is verified against
checked-in SHA256 and manifest length; the lockfile pins npm integrity too.
`opencode acp` uses newline-delimited JSON-RPC protocol version 1 with loadSession
and HTTP MCP. Do not assume a native/private steer method: steering cancels and
starts a continuation in the same session, merging usage into one Armada prompt.

Each turn opens a process, loads saved native state and suppresses replay before
publishing new output. Exact native session identity is checked before resume is
acknowledged. Model choice is explicit; MCP is re-delivered on new/load. Permission
requests can choose only an explicit one-shot allow inside the admitted sandbox;
client filesystem/terminal RPCs are not advertised. Runtime ChildOwner keeps
process-group ownership through teardown. Raw RPC errors never become diagnostics.

The private custom endpoint uses inline `OPENCODE_CONFIG_CONTENT`, fixed `armada`
provider and `@ai-sdk/openai-compatible`. API keys are memory-only driver environment,
not argv, golden/project config or public receipts. Native updates/catalog fetches
are disabled. Export/import persists only atomic redacted `sessions/<id>.json`
(mode 0600), not SQLite/WAL, auth, logs or provider caches. No-text restore imports
and verifies the exact session; missing/malformed export refuses, not replacement.

Local checks:

```sh
bun test packages/agent-runtime/test/acp.test.ts packages/agent-runtime/test/opencode.test.ts
bun packages/agent-runtime/build.ts
```

The pinned CLI can be probed with ACP initialize (protocolVersion 1, loadSession
true) without a model key. A fake-compatible-endpoint turn plus export/import
checks redaction, no replay and fresh usage, but does not prove a deployed
DeepSeek lifecycle or plan-key terms/acceptance. The coordinator-owned lifecycle
check above remains the real-provider gate.

## Anthropic Messages connections (#1579)

The shared connection preset **Anthropic for OpenCode** creates a named OpenCode
account with a fixed `https://api.anthropic.com/v1` address and the selected
Anthropic model IDs. Choose this instead of **Anthropic API key**, which remains
a Claude Code account. The dashboard renders this choice from the same core
preset definition used to validate the saved credential; no new credential kind
or migration is needed.

The sealed endpoint additionally carries `protocol: "anthropic"`. The runtime
selects the pinned OpenCode binary's native `@ai-sdk/anthropic` provider rather
than sending Messages requests through its OpenAI-compatible adapter. The API
key remains in private memory-only configuration, never project files. Existing
connections without this field keep their OpenAI-compatible behavior. Arbitrary
SDK/package names and unknown protocol values are refused. Models retain the
`armada/<model-id>` namespace so existing launch selection and pricing bindings
remain valid. A model without saved pricing remains honestly unpriced.

Coordinator staging verification after the normal deployment: create the
**Anthropic for OpenCode** connection with a real key, then add matching
`account: "opencode-anthropic"` entries to the existing staging account cases
(one Modal golden and one owned Docker host). Run:

```sh
ARMADA_SMOKE=create_real_compute bun scripts/post-deploy-smoke.ts --parity --accounts
```

Use the normal staging `ARMADA_URL`, `ARMADA_TOKEN`, and `ARMADA_SMOKE_CASES`.
Verify both cells' answer, follow-up, stop/resume recall, token receipts, honest
cost classification and cleanup. This procedure is not evidence of a successful
real Anthropic request; deterministic tests cover sealed credential validation
and native adapter selection, not the live provider. Azure v1 endpoint support
is described below; legacy versioned endpoints remain unsupported.

## Azure v1 connections for OpenCode (#1579)

Choose **Azure for OpenCode** in the shared connection presets. Supply the
resource's OpenAI v1 address, its API key and deployment names (not the underlying
model names). Azure OpenAI and Foundry addresses ending in `/openai/v1` are
accepted, as is a pasted `/openai/v1/responses` URL. The native Azure SDK handles
Azure API-key authentication and Responses requests; the generic chat-completions
adapter is not used. Existing generic connections are not silently converted.
See Microsoft's [endpoint and deployment-name guidance](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/switching-endpoints).

The sealed endpoint uses `protocol: "azure"`. For the pinned Azure SDK, the
runtime strips the final `/v1` only on `*.openai.azure.com`, where the SDK appends
it itself; Foundry's full path is preserved. No user has to know this adjustment.
The SDK's v1 behavior owns any API-version query; the form does not expose a
legacy version field. Legacy deployment-scoped endpoints, arbitrary versioned
query strings, and interactive Entra authentication are unsupported in this
slice (tracked by #1579). Use the v1 resource address and an API key instead.

Coordinator verification uses the same command above with
`account: "opencode-azure"` cases for Modal and the owned Docker host, and models
`armada/<deployment-name>`. Verify answer, follow-up, stop/resume recall, tokens,
honest estimated/unknown costs and cleanup. Azure deployment names may have no
catalog price; unknown cost is not a free request. No live Azure request has been
proved by the deterministic adapter-selection tests.

## Shared provider presets in the CLI (#1579)

`armada creds presets` lists the same model connection choices as the dashboard,
including their compatible agent. `--json` returns non-secret preset metadata.
Create a named account with `creds connect`, without writing connection JSON or
choosing an internal credential kind:

```sh
armada creds connect opencode-anthropic --name 'Anthropic coding' \
  --models claude-opus-5-5 --file /private/anthropic-key
armada creds connect opencode-azure --name 'Azure coding' \
  --base-url https://resource.openai.azure.com/openai/v1 \
  --models my-deployment --file /private/azure-key
armada creds connect deepseek --name 'DeepSeek coding' \
  --models deepseek-flash --file /private/deepseek-key
```

Omit `--file` to pipe a key on stdin. Fixed provider addresses cannot be
overridden. Presets with resource-specific addresses require `--base-url`;
custom providers require comma-separated `--models`. Ordinary OpenAI,
Anthropic-for-Claude and OpenCode plan-key presets use the agent's own model
list and take neither address nor model options. Add `--org` for an authorized
shared account. This command creates accounts; the existing version-checked
replacement/import commands remain unchanged. Preset catalog prices are captured
by the same core serializer as dashboard creation; unknown prices remain unknown.

## OpenAI Responses connections for OpenCode (#1579)

Choose **OpenAI for OpenCode**, not **OpenAI API key** (the Codex account).
The shared preset fixes the official OpenAI address and selects the pinned
native OpenAI SDK's Responses API. The generic **Other OpenAI-compatible**
chat-completions route remains unchanged for other providers. No ChatGPT
subscription import or automatic conversion of an existing account is implied.

```sh
armada creds connect opencode-openai --name 'OpenAI coding' \
  --models gpt-6.1-sol --file /private/openai-key
```

This creates a named `opencode` account with a sealed `protocol: "openai"`
endpoint. Model IDs retain the `armada/` launch namespace. Credentials stay in
private native configuration; the user supplies neither a URL nor connection
JSON. Prices are unknown unless explicitly saved; an API key does not imply a
ChatGPT plan or a known per-token price for a custom model name.

After normal deployment, the coordinator can add `opencode-openai` account cases
for Modal and the owned Docker host and run the existing
`--parity --accounts` command above. Verify answer, follow-up, stop/resume recall,
tokens, honest cost classification and cleanup. Deterministic tests prove sealed
configuration/CLI routing, not a successful live OpenAI lifecycle.

Account setup guidance does not decide placement support. The selected provider's
launch options and the server's admission policy remain authoritative; saving a
connection is not proof that every provider accepts it. In particular, the
owned-Docker runtime path accepts custom accounts independently of golden/native
provider launch paths. Older "Modal only" setup hints were stale and are removed;
this wording change does not enable any previously refused launch combination.
