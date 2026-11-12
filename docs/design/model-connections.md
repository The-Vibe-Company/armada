# Model connections (#1162)

Design slice of #1160; no runtime, schema or UI change in this PR.
Binding owner decisions in #1162 govern this design. Start Azure AI Foundry
for Codex on Modal now, in parallel with #1161; do not wait for Boat parity.

## Current state
- `packages/core/src/credentials.ts`: named, versioned model accounts; personal
  scope precedes org scope, explicit selection fails closed, multiple accounts
  require a default or selection. Kinds: `claude_oauth`, `anthropic`, `openai`,
  `codex_auth`; provider/Skillpack credentials are separate.
- `packages/core/src/templates.ts` and `template-service.ts`: templates pin
  `modelAccount.id/version`; admission rechecks status, access and version.
- `packages/core/src/readable-variables.ts` and `application-vault.ts` reserve
  harness configuration names. Readable variables are not a credential channel.
- `packages/agent-runtime/src/{protocol,runtime,native-auth,codex,claude}.ts`
  implement Modal's private runtime and harness adapters. Codex currently logs in
  with `OPENAI_API_KEY` over JSONL or uses isolated native subscription auth.
- `packages/provider-boat/src/provider.ts` uses Boat's native prompt API.
  `packages/core/src/model-prices.ts` is a price table, not billing truth.

## One object, existing storage

Extend model rows in `credentials`, not a second vault. Public connection DTO:
`id, scope(user|org), ownerId, name, harness, mode(subscription|api_key|custom),
version, status, isDefault, endpoint?, options?, models[]`.
Each model has a free-text `id` (Azure deployment name where appropriate),
optional display name and optional nonnegative USD-per-million-token prices
`input, cachedInput, output`. Missing prices mean unknown, never zero cost.
The #1163 cost lane owns calculation and precedence; it consumes these overrides
and harness-reported usage, including subscriptions, not gateway estimates.
Endpoint is an HTTPS base URL, not a proxy service hosted by Armada.
Reject URL userinfo, fragments and secret-bearing query strings; typed options
carry only non-secret configuration. No arbitrary headers, env maps or TOML.

Keep the sealed `value_enc` and existing `ARMADA_ENCRYPTION_KEY` scheme; secrets
enter via stdin/file or a write-only dashboard field, never argv or API reads.
An additive migration maps existing kinds to modes/harnesses without changing
IDs, ciphertext, versions, defaults, ownership or status: `claude_oauth` and
`codex_auth` become subscription, `anthropic` and `openai` become api_key.
Keep legacy kind/API/CLI adapters so existing accounts and pinned templates work
without user action. Boat/Modal/Skillpack credentials remain untouched.
Retain RLS, column grants, org-admin writes and whole-account resolution rules.
New migration versions must exceed every version on fresh origin/main.

## Runtime boundary and transport-independent payload

Resolve/authorize one connection server-side, then freeze its ID/version, model
and non-secret options in the launch manifest; recheck at admission/later turns.
Never silently fall back to a default/vendor endpoint if selection is invalid.
Use one versioned resolved payload: `{ schemaVersion: 1, connectionId,
connectionVersion, harness, mode, model, endpoint?, options?, auth }`.
`auth` is a discriminated secret value (API key, Claude token or Codex auth JSON),
not a public DTO; never persist it in manifests, exec text, argv, events or logs.
Deliver this object through today's private Modal bootstrap. #1161's enrolment
fetch can serve the identical object later: no Modal IDs or transport fields.
The future host passes only a single-use enrolment token; runtime fetches config
and credentials at start/resume, opens a new epoch, and returns refreshed
subscription tokens to the server. #1161 owns enrolment/epochs/dial-out transport;
this lane does not implement them or migrate Modal's tunnel early.
Runtime owns isolated auth/config files (owner-only permissions) and child env.
Codex uses a runtime-owned `CODEX_HOME/config.toml` provider plus secret env;
custom mode must bypass the existing built-in OpenAI login branch. Claude gets
only the selected base URL/auth variables, not competing subscription/API auth.
No secret in a golden; remove transient files on replacement/cleanup and register
all secret leaves for redaction. Connection-test errors retain useful provider
status/message after redaction, never raw request headers or response bodies.

## Harness options (primary docs checked 2026-11-12)

| Harness / path | Typed options and generated configuration | Delivery |
| --- | --- | --- |
| Codex subscription / vendor API | Existing auth.json / API-key login, unchanged | Existing providers |
| Codex custom, including Azure | `baseUrl`, optional `apiVersion`; generate a private provider ID, select `model_provider`, set `model_providers.<id>.base_url`, `env_key`, `wire_api="responses"`; optional `query_params["api-version"]` | Modal first |
| Claude subscription / vendor API | Existing OAuth token / `ANTHROPIC_API_KEY`, unchanged | Existing providers |
| Claude gateway | `baseUrl`, `authMode=bearer|api_key`; emit `ANTHROPIC_BASE_URL` and exactly one of `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | Modal first |
| Claude Bedrock | `CLAUDE_CODE_USE_BEDROCK`, AWS region/auth | Later |
| Claude Vertex | `CLAUDE_CODE_USE_VERTEX`, project/region and Google credentials | Later |
| Claude Microsoft Foundry | `CLAUDE_CODE_USE_FOUNDRY`, resource/base URL and Azure auth | Later |
| OpenCode | Same connection envelope, provider-specific options defined by #1164 | #1164, not this lane |

Sources: [Codex advanced configuration](https://developers.openai.com/codex/config-advanced),
[Claude gateway connection](https://code.claude.com/docs/en/llm-gateway-connect),
[Bedrock](https://code.claude.com/docs/en/amazon-bedrock),
[Vertex](https://code.claude.com/docs/en/google-vertex-ai),
[Foundry](https://code.claude.com/docs/en/microsoft-foundry).
Recheck these against the pinned harness versions during each implementation.
Accept `https://<resource>.services.ai.azure.com/api/projects/<project>/openai/v1`
and the same URL ending in `/responses`; remove only that optional suffix,
preserving the project path. No `api-version` is needed; bearer auth was verified by the
coordinator. Never receive the owner's real key in a worker. Legacy Azure paths
may need explicit `apiVersion`; do not impose it on v1. This slice supports Responses only:
a chat-completions-only endpoint (e.g. DeepSeek) is not a Codex connection.
Claude Code supports Claude models only. Show these limits in CLI and UI.

## Binding programme boundaries

Hosts supply machines, stdin command execution, persistence and outbound HTTPS;
agent features belong only to runtime. #1161 owns the compiled OS/arch artifact,
selected pinned harness download, digest bootstrap and later WS/HTTPS dial-out
with acknowledged journal batches. Versions change only at start/resume.
Keep Codex app-server and Claude Agent SDK drivers; #1164 owns ACP v1 OpenCode.
#1163 prices runtime-reported per-turn tokens server-side; missing means unknown.
Boat Codex opt-in precedes Claude/default/native-runner deletion. Docker follows
OpenCode; Modal moves to dial-out last and then deletes its tunnel. Do not bring
those later steps into this lane's Modal-first PRs.

## Independently mergeable slices and staging checks

Each later branch is `codex/1162-<slug>` from fresh origin/main, PR `Refs #1162`.
Only the coordinator uses staging credentials/deploys; workers never do.

1. **Design (this PR):** after deploy, no behavior changes expected. Coordinator
   opens this document, confirms the object/options/slice boundaries, and runs
   an existing saved account's launch; expect its normal successful response.
2. **Azure-first Codex server/schema/runtime/API (Modal, start now):** coordinator creates a custom
   connection through the control API using their Azure resource/key and model
   deployment, selects it at launch, sends “Reply exactly MODEL_OK”, then sends
   a second turn; expect MODEL_OK both times through Azure. Repeat for a generic
   Responses endpoint. Try an invalid key and revoked connection: expect a
   redacted provider error / admission rejection, no vendor fallback. Re-run
   existing subscription/API-key launches. PR supplies exact request commands.
3. **Claude gateway (Modal):** same API steps with a Claude gateway and bearer
   then API-key auth; expect MODEL_OK on initial and later turns. Bad key must
   expose the redacted real error. Repeat existing Claude subscription/API key.
4. **CLI + dashboard Models:** coordinator creates/tests both connections in
   Models and CLI (secret from stdin/file), picks each in a launch and template,
   publishes and launches the template; expect MODEL_OK. For Azure, repeat in
   CLI and dashboard with both pasted URL forms above: expect successful initial
   and subsequent turns, with no duplicated `/responses`. Test sends one tiny
   harness request, warns of possible billing, and displays success or redacted
   error. Inspect list/get/events/logs: no secrets. PR supplies final commands
   and click steps, including unknown-price and incompatible-harness states.

Until #1161 provides runtime parity on Boat, custom connections are **Modal
only**: reject Boat custom launches/tests before allocating a sandbox and show
that limit in options/UI/CLI. Existing Boat accounts continue on the native path;
no ad-hoc SSH/exec configuration workaround. After #1161, reuse the same runtime
payload on Boat and repeat checks 2–4 there; #1161 owns native-runner removal.
#1165 owns Docker transport; #1164 owns OpenCode/DeepSeek integration.

## Deletions and Later

Replace fixed model-kind-to-env dispatch with the runtime connection renderer
as each harness migrates; retain only legacy input adapters, not two renderers.
No removal of Boat's native path here; it belongs to #1161 after parity.
Later: direct Bedrock/Vertex/Foundry cloud identity flows, rotating credential
helpers, arbitrary headers, model discovery, enterprise endpoint allowlists and
multi-tenant egress hardening. Do not build these for the owner-team first slice.
