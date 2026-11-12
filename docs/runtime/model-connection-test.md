# Runtime-backed connection check (private primitive)

Refs #1162. This slice adds the runtime operation underpinning a later public
CLI/dashboard Test Connection action, not those public controls themselves.
It follows the runtime-only owner decision: no model request goes through a
host API or directly from the Armada server.

An already bootstrapped Modal runtime accepts this authenticated protocol-1 RPC:

```json
{"version":1,"requestId":"unique-id","sandboxId":"modal_<logical-uuid>","op":"testModelConnection","harness":"codex","model":"deployment-name"}
```

Only the selected custom connection from the current private bootstrap is used.
The RPC accepts no URL, key, arbitrary headers or prompt. Subscription and plain
vendor-default credentials are not checked by this first primitive. Builders,
checkpointed/busy runners and unsupported/unconfigured harnesses refuse it.
The operation joins the runtime's in-flight command set so checkpoint waits
for it. It creates no prompt, journal event or replay receipt; each invocation
is fresh and may incur a tiny provider charge. No automatic retry is made.

Codex sends one Responses request (16-token output cap, no storage); Claude
sends one Messages request (one-token cap) with its configured bearer or
x-api-key mechanism. A valid incomplete Responses result counts as connectivity,
not a completed answer. This does not prove harness tool/streaming compatibility.
The total deadline is 15 seconds, response body is capped at 16 KiB, redirects
are forbidden, and caller cancellation aborts the request. JSON response shape
is checked; an HTML 200 is not success.

Result: `{ok,status,error,code}`. Error is provider_rejected, invalid_response,
connection_failed, or null. Status is the real HTTP status (null on transport
failure). Code is a recognized provider diagnostic such as invalid_api_key,
DeploymentNotFound or rate_limit_error, or null. Free-form error text, headers,
model output and unknown diagnostics are deliberately never returned: providers
can echo keys. Future public UI must not claim a successful check proves a
complete agent turn or support for arbitrary models.

Wire fields checked against the official [Responses create API](https://developers.openai.com/api/reference/resources/responses/methods/create)
and [Messages API](https://platform.claude.com/docs/en/api/messages), using the
existing gateway-compatible anthropic-version 2023-06-01 documented in the
[Claude gateway setup](https://code.claude.com/docs/en/llm-gateway-connect).

## Coordinator staging check

1. Deploy rebuilt runtime with the server. Launch an ordinary Modal sandbox
   using an owner-held Foundry/gateway connection as in the existing connection
   docs. Obtain its current RunnerAccess (`url`, `connectToken`, `grant`) from
   the server's authorized Modal access resolver; keep it private. Add the
   matching logical runner `sandboxId` (`machine.info.id`, e.g. `modal_<uuid>`,
   not the host physical `sb-...` ID or the separate Armada database row UUID), selected `harness` and deployment `model` to
   that private JSON input (outside the repo). Do not pass tokens in arguments.
2. Run `ARMADA_MODEL_CONNECTION_SMOKE=use_staging_runner bun scripts/smoke-model-connection.ts < /path/to/private-runner-access.json`.
   Expect exactly MODEL_CONNECTION_OK, with one tiny request observed at the
   owner endpoint. Repeat for Foundry base URL with/without /responses and each
   supported Claude auth mechanism. Do not send requests to production.
3. With a new sandbox bound to a deliberately invalid key, expect smoke failure;
   an authorized RPC inspector must see real HTTP401 and a recognized safe code,
   never key/response text. Wrong model may yield HTTP404/DeploymentNotFound.
   Wrong/expired grant and extra URL/key fields must refuse before outbound I/O.
4. Check that session prompts/events are unchanged and runtime checkpoint still
   completes. Delete private access files afterwards.

Prerequisites: current custom connection bootstrap and updated runtime artifact.
No migration/new settings. Workers hold no owner credentials or staging access.
