import { MACHINE_SIZES, MAX_SANDBOX_EXTENSION_TTL_SECONDS, VERSION } from "@armada/core";
import { OrchestratorAuthorityDenied } from "@armada/core/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Route } from "./http.ts";
import type { createOrchestratorChildren } from "./orchestrator-children.ts";
import { InvalidOrchestratorBody, readOrchestratorBody } from "./orchestrator-http-body.ts";

/** Trusted662 bootstrap URL: never point an epoch grant at the generic owner /mcp. */
export const ORCHESTRATOR_SCOPED_PATH = "/api/v1/orchestrator-tools";
export function orchestratorScopedMcpUrl(publicUrl: string): string {
  const url = new URL(publicUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Invalid scoped gateway origin.");
  return new URL(`${ORCHESTRATOR_SCOPED_PATH}/mcp`, url).toString();
}
const key = z.string().regex(/^[ -~]{1,128}$/);
const text = z
  .string()
  .min(1)
  .max(100_000)
  .refine((value) => value.trim().length > 0);
const selection = z
  .object({
    goldenId: z.uuid(),
    harness: z.enum(["claude", "codex"]),
    credentialId: z.uuid(),
    credentialVersion: z.number().int().positive().safe(),
    model: z.string().min(1).max(200),
    skills: z.array(z.string()).max(20).optional(),
    reasoningEffort: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    prompt: text.optional(),
    size: z.enum(MACHINE_SIZES).optional(),
  })
  .strict();
const schemas = {
  launch: z.object({ idempotencyKey: key, selection }).strict(),
  read: z.object({ sandboxId: z.uuid() }).strict(),
  message: z.object({ idempotencyKey: key, sandboxId: z.uuid(), text }).strict(),
  stop: z.object({ idempotencyKey: key, sandboxId: z.uuid() }).strict(),
  extend: z
    .object({
      idempotencyKey: key,
      sandboxId: z.uuid(),
      ttlSeconds: z.number().int().positive().max(MAX_SANDBOX_EXTENSION_TTL_SECONDS),
    })
    .strict(),
};
const restSchemas = {
  launch: schemas.launch.omit({ idempotencyKey: true }),
  read: schemas.read,
  message: schemas.message.omit({ idempotencyKey: true }),
  stop: schemas.stop.omit({ idempotencyKey: true }),
  extend: schemas.extend.omit({ idempotencyKey: true }),
};
type Method = keyof typeof schemas;
const childMethod = (value: string): value is Method => Object.hasOwn(schemas, value);
const waitMethods = new Set(["wait_record", "wait_renew", "wait_complete"]);
class InvalidScopedRequest extends Error {}
class WaitAuthorityUnavailable extends Error {}
const fail = (status: number, code: string) =>
  Response.json({ error: { code, message: code } }, { status, headers: { "cache-control": "no-store" } });

/** Separate principal surface. Metadata/init are static and convey NO authenticated identity;
 * every data/effect call reaches the real Authority boundary through children. No Caller exists. */
export function createOrchestratorScopedGateway(children: ReturnType<typeof createOrchestratorChildren>): Route {
  async function call(token: string, name: string, args: unknown): Promise<unknown> {
    if (waitMethods.has(name)) throw new WaitAuthorityUnavailable();
    if (!childMethod(name)) throw new InvalidScopedRequest();
    const parsed = schemas[name].safeParse(args);
    if (!parsed.success) throw new InvalidScopedRequest();
    if (name === "launch") {
      const input = schemas.launch.parse(args);
      const chosen = input.selection;
      return children.launch(token, input.idempotencyKey, {
        goldenId: chosen.goldenId,
        harness: chosen.harness,
        credentialId: chosen.credentialId,
        credentialVersion: chosen.credentialVersion,
        model: chosen.model,
        ...(chosen.skills === undefined ? {} : { skills: chosen.skills }),
        ...(chosen.repo === undefined ? {} : { repo: chosen.repo }),
        ...(chosen.prompt === undefined ? {} : { prompt: chosen.prompt }),
        ...(chosen.reasoningEffort === undefined ? {} : { reasoningEffort: chosen.reasoningEffort }),
        ...(chosen.size === undefined ? {} : { size: chosen.size }),
      });
    }
    if (name === "read") {
      const input = schemas.read.parse(args);
      return children.read(token, input.sandboxId);
    }
    if (name === "message") {
      const input = schemas.message.parse(args);
      return children.message(token, input.idempotencyKey, input.sandboxId, input.text);
    }
    if (name === "extend") {
      const input = schemas.extend.parse(args);
      return children.extend(token, input.idempotencyKey, input.sandboxId, input.ttlSeconds);
    }
    const input = schemas.stop.parse(args);
    return children.stop(token, input.idempotencyKey, input.sandboxId);
  }
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== ORCHESTRATOR_SCOPED_PATH && !url.pathname.startsWith(`${ORCHESTRATOR_SCOPED_PATH}/`))
      return null;
    const suffix = url.pathname.slice(ORCHESTRATOR_SCOPED_PATH.length + 1);
    // Owner sessions/service keys are NOT promoted into delegated authority, or vice versa.
    const match = /^Bearer (armada_epoch_[a-f0-9]{64})$/.exec(request.headers.get("authorization") ?? "");
    if (!match?.[1]) return fail(401, "invalid_epoch_authority");
    if (request.method !== "POST") return fail(405, "use_post");
    const token = match[1];
    try {
      const raw = await readOrchestratorBody(request);
      const decoded: unknown = JSON.parse(raw);
      if (suffix !== "mcp") {
        if (waitMethods.has(suffix)) return fail(503, "admit_wait_not_supported");
        if (!childMethod(suffix)) return fail(403, "scoped_method_denied");
        const input = restSchemas[suffix].safeParse(decoded);
        if (!input.success) throw new InvalidScopedRequest();
        const args =
          suffix === "read" ? input.data : { ...input.data, idempotencyKey: request.headers.get("idempotency-key") };
        return Response.json({ result: await call(token, suffix, args) }, { headers: { "cache-control": "no-store" } });
      }
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new InvalidScopedRequest();
      const rpc = decoded as { method?: unknown; params?: { name?: unknown; arguments?: unknown }; id?: unknown };
      if (rpc.method === "tools/call") {
        const name = rpc.params?.name;
        // Validate BEFORE SDK defaults can strip extra fields from a tool's arguments.
        if (typeof name !== "string" || (!childMethod(name) && !waitMethods.has(name)))
          return fail(403, "scoped_method_denied");
        if (waitMethods.has(name)) return fail(503, "admit_wait_not_supported");
        if (!childMethod(name) || !schemas[name].safeParse(rpc.params?.arguments).success)
          throw new InvalidScopedRequest();
      }
      const server = new McpServer({ name: "armada-owned-worker-tools", version: VERSION });
      for (const name of Object.keys(schemas) as Method[])
        server.registerTool(
          name,
          {
            description: "Scoped own-child operation. No owner/admin/credential/general sandbox authority.",
            inputSchema: schemas[name],
            outputSchema: z.object({ result: z.unknown() }),
          },
          async (args: unknown): Promise<CallToolResult> => {
            try {
              const result = { result: await call(token, name, args) };
              return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
            } catch (error) {
              const code =
                error instanceof OrchestratorAuthorityDenied
                  ? "scoped_authority_denied"
                  : "scoped_operation_unavailable";
              return { isError: true, content: [{ type: "text", text: code }] };
            }
          },
        );
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      try {
        return await transport.handleRequest(new Request(request, { body: raw }));
      } finally {
        await server.close();
      }
    } catch (error) {
      if (error instanceof OrchestratorAuthorityDenied) return fail(403, "scoped_authority_denied");
      if (error instanceof WaitAuthorityUnavailable) return fail(503, "admit_wait_not_supported");
      if (
        error instanceof InvalidScopedRequest ||
        error instanceof InvalidOrchestratorBody ||
        error instanceof SyntaxError ||
        error instanceof z.ZodError
      )
        return fail(400, "invalid_scoped_request");
      return fail(503, "scoped_operation_unavailable");
    }
  };
}
