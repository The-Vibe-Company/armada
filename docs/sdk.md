# TypeScript SDK

`@the-vibe-company/armada-sdk` (`npm install @the-vibe-company/armada-sdk`) is a small fetch-based client for the Armada `/api/v1` API. It runs in Bun, Node.js 20.3+ and browsers with Web Crypto. Its source is the private workspace package `packages/sdk` (`@armada/sdk`), which uses the browser-safe core operation contract. Releases bundle it with that core code into a dependency-free ES module and self-contained declarations (`scripts/npm.ts`), smoke-test the packed tarball in an isolated install (`scripts/npm-smoke.sh`) and publish it with the CLI (`docs/releasing.md`). Keep service tokens on your application's backend, never in public browser bundles.

```ts
import { Armada, ArmadaError, verifyWebhookSignature } from "@the-vibe-company/armada-sdk";

const armada = new Armada({ token: process.env.ARMADA_TOKEN! });
const { sandbox } = await armada.launch({
  provider: "boat", golden: "product-worker", harness: "codex", prompt: "Implement the requested change",
  idempotencyKey: crypto.randomUUID(),
});
const result = await armada.wait({ id: sandbox.id, timeout_seconds: 60 });
const page = await armada.logs({ id: sandbox.id });
await armada.send({ id: sandbox.id, prompt: "Review the change", request_id: crypto.randomUUID() });
await armada.stop({ id: sandbox.id });
```

The client sends its service token on every request, so `url` must be an `https:` origin. Plain `http:` is accepted only for loopback hosts (`localhost`, `127.0.0.0/8` and `[::1]`), for local servers and test fixtures; any other `http:` origin throws a `TypeError` before a request is made.

`launch` accepts `DockerLaunchInput` with `provider: "docker"`, `harness`, and either `hostId` (with optional `repos`) or `snapshotId` (which selects its host and workspace). Supply an `idempotencyKey` of 16–128 characters and keep it for retries. An optional `externalRef` lets you find the sandbox later. With a service token, omit `org` or set it to the token's organization UUID. Discover Docker availability with `launch/options`.

`launch` calls return the shared `LaunchResult` envelope for Boat, Modal and Docker. Read the Armada ID from `sandbox.id` and the provider ID from `sandbox.providerSandboxId`. Check `golden` before reading `golden.name`, since Docker returns `golden: null`. The required `promptId` and `conversationId` fields are `null` when their IDs are unavailable, including an idle launch. Provider-specific sandbox metadata is available as additional fields with type `unknown`.

For a pinned Modal template, pass `PinnedModalLaunchInput` to `launch` with
`provider: "modal"`, `runtimeVersion: 1`, `runtimeTransport: "dialout"`, the template
`id`, its `revision` and `harness`, and an `idempotencyKey`. Keep the key for
identical retries and use `externalRef` to correlate the sandbox.

`send` opens or continues the conversation of the sandbox identified by `id`. Launch another sandbox for a separate conversation.

`send` to a Docker sandbox uses the shared `SendInput`. For Docker, `model` and `reasoning_effort` are refused with `invalid_request` before anything is queued, because a Docker sandbox keeps the model and effort chosen at launch. The prompt is queued durably under `request_id`, a lowercase UUID: supply one to retry uncertain delivery with the same `request_id` and identical input, and use a new one for a new turn. When `request_id` is omitted the server generates one (the receipt's `requestId`), so a retry without it queues the prompt again; a caller-supplied key is required for a safe replay.

Every request body is limited to 128 KiB of serialized JSON: a larger body fails with code `invalid`, HTTP 413 and `outcomeUnknown: false` before anything is dispatched. `launchFromTemplate` is limited to 64 KiB, and the server refuses a larger template body with code `invalid` and HTTP 400, also before anything is dispatched. This bounds a `send` prompt below Docker's own 256 KiB admission limit, so over REST the body limit is the effective prompt limit. Each OpenAPI operation publishes its limit in `requestBody.x-max-body-bytes` and the server's refusal status in `requestBody.x-oversized-body-status`. Golden (Boat and Modal) sandboxes take `SendInput`, whose optional `model` and `reasoning_effort` override one turn.

`launchFromTemplate` accepts the server's `org`, template `id`, optional `revision`, and durable `requestKey`, plus supported prompt/resource overrides. Retain the original key and identical input after uncertain delivery. The result is a receipt with a `requestId` and `state` (`succeeded`, `failed` with a `reason`, or still in progress) or, when golden admission refuses the launch before any request is recorded, a refusal: HTTP 200, `state: "failed"`, a golden `reason` and `message`, and no `requestId`. Nothing was launched in that case. Check `"requestId" in result` before using the receipt. Ordinary launches also support a durable `idempotencyKey` when enabled by the server. Native send operations do not guarantee deduplication even when given a `request_id`.

All methods accept a final `{ signal, timeoutMs }` request option. The per-call `timeoutMs` wins over the client `timeoutMs`; without either, requests stop after five minutes and `wait` after its server wait plus 30 seconds. A client `timeoutMs` shorter than the server wait therefore ends `wait` early with `transport_error`; pass a longer per-call `timeoutMs` to `wait`. `wait` performs one bounded server wait and returns `timedOut`; call it again when necessary. Logs return one page by default; pass `cursor` into the next call. `follow` is bounded by the request timeout.

`ArmadaError` exposes a typed `code`, HTTP `status`, optional original `serverCode`, `outcomeUnknown`, and `retryAfterSeconds` when the server asked for a delay. Recognized server codes come from the operation contract and shared API failures. Codes with a dedicated help message use the core’s safe text. Unknown codes are preserved separately; untrusted server messages and details never enter errors. A transport failure (including a connection that fails or times out while a successful response body is being read) is `transport_error`; a response that is not a JSON object is `unknown_response`. A transport failure or server failure during a mutation can mean the operation was accepted: inspect status/receipts before retrying.

Automatic retries default to zero. Set `readRetries` (maximum 3) to replay only read-only status, wait and logs after HTTP 429/502/503/504. The client performs no retries when the server asks for a delay (a `Retry-After` header, or `retryAfterSeconds` in the failure body such as a provider rate limit). The caller owns delayed scheduling: wait at least `error.retryAfterSeconds` before trying again. A draining server refuses with HTTP 503 before dispatching anything: that error has code `unavailable` and `outcomeUnknown: false`, so a mutation can be sent again after the delay. Transport failures and mutations are never automatically retried. A request's timeout and abort signal cover all attempts.

`files.read({ id, path })` and `files.write({ id, path, content })` are UTF-8 helpers over the existing authorized `sandbox/exec` API. Writes require the guest's `base64` command; reads use plaintext `cat` so the server can redact known credentials, have the same filesystem authority and credential redaction as exec, and reject failed, timed-out or truncated results. They are intended for small application text files; writes are limited to 32 KiB and overwrite the target directly. A failed write can leave partial content. If the server admitted the command but could not confirm its result, the write fails with code `outcome_unknown`, HTTP 503 and `outcomeUnknown: true`: the command may still run, so read the file back before writing it again. A command refused before admission is a definite `conflict` (HTTP 409, `outcomeUnknown: false`). They are not an archive or binary transfer API, do not create parent directories and never retry.

Verify outbound webhook signatures against the exact raw request body before parsing JSON:

```ts
const valid = await verifyWebhookSignature({
  secret: endpointSecret,
  body: await request.text(),
  headers: request.headers,
});
```

The verifier implements the server's `v1=HMAC-SHA256(secret, timestamp.id.body)` signature with Web Crypto and defaults to a five-minute timestamp tolerance. Store `Armada-Webhook-Id` values durably and reject duplicate deliveries to prevent replay within that window. `now` (milliseconds) and `toleranceSeconds` are configurable for deterministic verification and clock policy. Delivery retries may legitimately repeat the same ID.

The checked-in [OpenAPI 3.1 description](../packages/mcp-server/openapi.json) projects public and agent operations from `@armada/core/contract`, including launch discovery (`launch/options`, `golden/list`). Operations marked `x-armada-direct-server` use the server origin directly. The dashboard proxy test checks that distinction and requires a reason for each forwarded route outside the description. Administrative routes and some provider extensions are documented separately.

`sandbox/send` publishes the shared send input and a Docker variant that adds the rules from `packages/mcp-server/src/docker-send-request-schema.ts`. The server selects the variant based on the sandbox’s provider. `sandbox/launch` publishes golden and explicit runtime variants, plus Docker host and snapshot variants that require an idempotency key. The HTTP launch receipt contains `sandbox.id`. Template launch returns a receipt with `requestId` or a pre-admission refusal. REST `launch/options` and MCP `launch_options` share the launch catalog response schema from `@armada/core/contract`.

`Armada.logs({ id })` pages sandbox history by ID. The REST and MCP logs operations share an output that includes `queuedPrompt` for a prompt the Docker runtime has yet to admit. Status and wait expose the same condition as `prompt.state: "queued"`. The SDK types request bodies and responses from the operation schemas. In particular, `logs.settled` is optional.

Run `bun scripts/generate-openapi.ts` after contract changes. The generator reads the operation schemas and uses the HTTP field names for launch and logs. The drift test compares the checked-in artifact with the generated document.
