# TypeScript SDK

`@the-vibe-company/armada-sdk` (`npm install @the-vibe-company/armada-sdk`) is a small fetch-based client for the Armada `/api/v1` API. It runs in Bun, Node.js 20.3+ and browsers with Web Crypto. Its source is the private workspace package `packages/sdk` (`@armada/sdk`), which imports only the browser-safe core entry point and never server, provider or database code. Releases bundle it with that core code into a dependency-free ES module and self-contained declarations (`scripts/npm.ts`), smoke-test the packed tarball in an isolated install (`scripts/npm-smoke.sh`) and publish it with the CLI (`docs/releasing.md`). Keep service tokens on your application's backend, never in public browser bundles.

```ts
import { Armada, ArmadaError, verifyWebhookSignature } from "@the-vibe-company/armada-sdk";

const armada = new Armada({ token: process.env.ARMADA_TOKEN! });
const { sandbox } = await armada.launch({
  golden: "product-worker", harness: "codex", prompt: "Implement the requested change",
  idempotencyKey: crypto.randomUUID(),
});
const result = await armada.wait({ id: sandbox.id, timeout_seconds: 60 });
const page = await armada.logs({ id: sandbox.id });
await armada.send({ id: sandbox.id, prompt: "Review the change", request_id: crypto.randomUUID() });
await armada.stop({ id: sandbox.id });
```

`launchFromTemplate` accepts the server's `org`, template `id`, optional `revision`, and durable `requestKey`, plus supported prompt/resource overrides. Retain the original key and identical input after uncertain delivery. The result is a `TemplateLaunchReceipt` with a `requestId` and `state` (`succeeded`, `failed` with a `reason`, or still in progress) or, when golden admission refuses the launch before any request is recorded, a `TemplateLaunchRefusal`: HTTP 200, `state: "failed"`, a golden `reason` and `message`, and no `requestId`. Nothing was launched in that case. Check `result.requestId !== undefined` before using the receipt. Ordinary launches also support a durable `idempotencyKey` when enabled by the server. Native send operations do not guarantee deduplication even when given a `request_id`.

All methods accept a final `{ signal, timeoutMs }` request option. The per-call `timeoutMs` wins over the client `timeoutMs`; without either, requests stop after five minutes and `wait` after its server wait plus 30 seconds. A client `timeoutMs` shorter than the server wait therefore ends `wait` early with `transport_error`; pass a longer per-call `timeoutMs` to `wait`. `wait` performs one bounded server wait and returns `timedOut`; call it again when necessary. Logs return one page by default; pass `cursor` into the next call. `follow` is bounded by the request timeout.

`ArmadaError` exposes a typed `code`, HTTP `status`, optional original `serverCode`, `outcomeUnknown`, and `retryAfterSeconds` when the server asked for a delay. Known public failure codes use the core's safe help messages. Unknown codes are preserved separately; untrusted server messages and details never enter errors. A transport failure (including a connection that fails or times out while a successful response body is being read) is `transport_error`; a response that is not a JSON object is `unknown_response`. A transport failure or server failure during a mutation can mean the operation was accepted: inspect status/receipts before retrying.

Automatic retries default to zero. Set `readRetries` (maximum 3) to replay only read-only status, wait and logs after HTTP 429/502/503/504. The client performs no retries when the server asks for a delay (a `Retry-After` header, or `retryAfterSeconds` in the failure body such as a provider rate limit). The caller owns delayed scheduling: wait at least `error.retryAfterSeconds` before trying again. A draining server refuses with HTTP 503 before dispatching anything: that error has code `unavailable` and `outcomeUnknown: false`, so a mutation can be sent again after the delay. Transport failures and mutations are never automatically retried. A request's timeout and abort signal cover all attempts.

`files.read({ id, path })` and `files.write({ id, path, content })` are UTF-8 helpers over the existing authorized `sandbox/exec` API. Writes require the guest's `base64` command; reads use plaintext `cat` so the server can redact known credentials, have the same filesystem authority and credential redaction as exec, and reject failed, timed-out or truncated results. They are intended for small application text files; writes are limited to 32 KiB and overwrite the target directly. A failed write can leave partial content. They are not an archive or binary transfer API, do not create parent directories and never retry.

Verify outbound webhook signatures against the exact raw request body before parsing JSON:

```ts
const valid = await verifyWebhookSignature({
  secret: endpointSecret,
  body: await request.text(),
  headers: request.headers,
});
```

The verifier implements the server's `v1=HMAC-SHA256(secret, timestamp.id.body)` signature with Web Crypto and defaults to a five-minute timestamp tolerance. Store `Armada-Webhook-Id` values durably and reject duplicate deliveries to prevent replay within that window. `now` (milliseconds) and `toleranceSeconds` are configurable for deterministic verification and clock policy. Delivery retries may legitimately repeat the same ID.

The checked-in [OpenAPI 3.1 description](openapi.json) covers the integration operations, the launch discovery calls (`launch/options`, `golden/list`) and shared-tool control routes. `packages/mcp-server/src/public-rest-routes.ts` is the explicit inventory: it lists every published route and gives a reason for every other route the public endpoint forwards, and the dashboard proxy test checks both directions. `sandbox/launch` publishes two request variants: a golden launch and a Docker launch (`provider: "docker"`, from `packages/mcp-server/src/docker-launch-request-schema.ts`, whose keys are also the fields the Docker handler accepts). Regenerate it with `bun scripts/generate-openapi.ts` after contract changes. It reads the server's registered input/output schemas without invoking tools, a database or a provider. REST launch and logs field names are adapted to their HTTP handlers. The two launch routes and the two discovery routes have no matching MCP output, so their HTTP 200 bodies are described by the server's response schemas (`packages/mcp-server/src/launch-response-schemas.ts`): the launch receipt with `sandbox.id`, and the template receipt (with `requestId`) or pre-admission refusal (without one). `logs/read` publishes the MCP `logs` output plus `queuedPrompt`, which a Docker sandbox returns for a prompt its runtime has not admitted yet. These records stay open to additional fields. Administrative and provider-specific extension routes are outside this description. The contract drift test checks the published artifact against current server registration.
