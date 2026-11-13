# OpenCode on Modal (#1164)

The coordinator released order step 4 on 2026-11-12 after verifying model
connections/cost on Modal. Boat parity runs in parallel and is not a prerequisite.
This implementation uses the same ACP v1 driver and shared catalog on every
supported host; **OpenCode is enabled on Modal only**. Boat fails before fork.

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

Apply the two new migrations in order before deploying the server. No worker
applies staging/production migrations. The second migration promotes the private
Modal harness binding from its old two-value text CHECK to the shared enum.

Build `bun packages/agent-runtime/build.ts` on the target Linux architecture.
The manifest records OpenCode **1.19.5** and its verified native SHA-256. Publish
`dist/opencode` under its SHA-256 filename in the existing
`ARMADA_RUNTIME_ARTIFACT_DIR` served at `/api/runtime/artifacts/<digest>`:

```sh
# Public executable bytes only. Run in the coordinator's artifact publication lane.
digest=$(sha256sum packages/agent-runtime/dist/opencode | cut -d ' ' -f 1)
cp packages/agent-runtime/dist/opencode "$ARMADA_RUNTIME_ARTIFACT_DIR/$digest"
```

Publish both architecture builds if Modal uses both. Only selected OpenCode
launches fetch this artifact, and only at start/resume when its verified native
binary/cache is missing. Older goldens need no model key or new native installer
baked into them. Wrong/missing bytes fail closed. No npm/latest fetch happens
inside a prompt and native auto-update is disabled. Native title generation is
disabled: Armada owns names and avoids unreported auxiliary model requests. Credentials arrive separately
in private stdin bootstrap; only the selected driver receives them. `OPENCODE_*`
and the four native `XDG_*_HOME` routing names are reserved readable-variable names so configuration cannot redirect
native credentials/history outside the checkpoint boundary.

Native Task delegation/custom agent modes are not exposed in this first slice:
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

1. Publish the artifact, migrate/deploy, create the account and launch as above
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
   Armada child access is enabled for OpenCode in this slice.

Worker evidence: the real pinned Linux x64 CLI passed ACP initialize, an actual
streaming fake-compatible-endpoint turn (10 input/5 output), redacted export,
checkpoint/restore, no-text native resume and follow-up with fresh 10/5 counters.
It requested `stream_options.include_usage:true`. No real model key was used;
this is not a claim that the deployed DeepSeek lifecycle has passed.

The real pinned CLI also passed a fake tool loop with `bash` and interleaved
reasoning replay: two model steps were metered as 13 input / 7 output / 2 reasoning
(tokens once, not only the final 3/2 step). After export/restore, follow-up usage
was 3/2, excluding prior history. No real provider key was used in that probe.
