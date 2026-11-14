import { timingSafeEqual } from "node:crypto";
import { type OttoEngine, VERSION } from "@armada/core";
import {
  type CredentialReader,
  canonicalOttoRepository,
  isOttoUuid,
  resolveOttoRepositories,
  type Sql,
} from "@armada/core/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Caller, CallerResult } from "../caller.ts";
import type { Route } from "../http.ts";
import { preflightOttoEngine } from "./engine-preflight.ts";
import { interviewCapability, type OttoEngineSessions } from "./engine-session.ts";
import { interviewStore, type OttoInterviewScope } from "./interview.ts";
import { objectiveStore } from "./objectives.ts";

const roundSchema = z
  .object({
    decisions: z.array(
      z
        .object({
          id: z.string().min(1),
          question: z.string().min(1),
          recommendation: z.string().min(1),
          answer: z.string().nullable(),
          source: z.string().nullable(),
          ownerAnswer: z
            .object({ revision: z.number().int().positive(), questionId: z.string().min(1), answer: z.string().min(1) })
            .strict()
            .nullable()
            .optional(),
          reversible: z.boolean(),
          dependsOn: z.array(z.string()),
        })
        .strict(),
    ),
    assumptions: z.array(z.object({ text: z.string().min(1), source: z.string().min(1) }).strict()),
    frontier: z.array(z.string()),
  })
  .strict();
export interface OttoInterviewToolsOptions {
  sql: Sql;
  reader: CredentialReader;
  key?: string | undefined;
  authenticate(request: Request): Promise<CallerResult>;
  sessions?: OttoEngineSessions | undefined;
  readFile?: (caller: Caller, repository: string, path: string) => Promise<{ text: string; source: string }>;
}
const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
async function readBody(request: Pick<Request, "body">): Promise<string> {
  let raw = "";
  const decoder = new TextDecoder();
  if (!request.body) return raw;
  for await (const chunk of request.body) {
    raw += decoder.decode(chunk, { stream: true });
    if (raw.length > 250000) throw Error("Request too large");
  }
  return raw + decoder.decode();
}
/** Owner web actions and engine capabilities never share authentication or authority. */
export function createOttoInterviewRoute(options: OttoInterviewToolsOptions): Route {
  const { sql } = options;
  return async (request) => {
    const url = new URL(request.url),
      match = url.pathname.match(/^\/api\/v1\/otto\/interviews\/([^/]+)(\/tools)?$/);
    if (!match) return null;
    if (!match[1] || !isOttoUuid(match[1])) return reply({ error: "not_found" }, 404);
    const objectiveId = match[1];
    try {
      if (match[2]) return await engineTools(options, request, objectiveId);
      const auth = await options.authenticate(request);
      if (!auth.ok) return reply({ error: "unauthorized" }, 401);
      const caller = auth.caller;
      if (caller.via !== "supabase") return reply({ error: "forbidden" }, 403);
      const orgId = url.searchParams.get("org_id");
      if (!orgId || !isOttoUuid(orgId) || !caller.orgs.some((o) => o.orgId === orgId))
        return reply({ error: "not_found" }, 404);
      const scope = { orgId, ownerId: caller.userId, objectiveId };
      const thread = await objectiveStore(sql, caller, orgId).thread(objectiveId);
      if (
        !thread ||
        !(await resolveOttoRepositories(sql, caller, orgId)).includes(
          canonicalOttoRepository(thread.objective.repository) ?? "",
        )
      )
        return reply({ error: "not_found" }, 404);
      const store = interviewStore(sql, scope);
      if (request.method === "GET") {
        const goldens = (await options.sessions?.goldens(caller, orgId)) ?? [];
        const effects = (
          await sql.query<{
            kind: string;
            state: string;
            skills: { reference: string; version: string; checksum: string }[] | null;
          }>(
            `select kind,state,case when kind='engine_start' and state='succeeded' then
              (select jsonb_agg(jsonb_build_object('reference',skill->>'reference','version',skill->>'version','checksum',skill->>'checksum')) from jsonb_array_elements(coalesce(result->'skills','[]'::jsonb)) skill)
              else null end as skills from public.otto_intentions where org_id=$1 and owner_id=$2 and objective_id=$3 order by created_at`,
            [orgId, caller.userId, objectiveId],
          )
        ).rows;
        return reply({
          interview: await store.read(),
          effects,
          goldens: goldens
            .filter((g) =>
              g.config.repos.some(
                (r) => canonicalOttoRepository(r.url) === canonicalOttoRepository(thread.objective.repository),
              ),
            )
            .map((g) => ({ id: g.id, name: g.name, provider: g.provider })),
        });
      }
      if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
      if (!options.sessions || !options.key) return reply({ error: "interview_unavailable" }, 503);
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "invalid_request" }, 400);
      let interview = await store.read();
      if (body.action === "start") {
        if (!interview) {
          if (typeof body.goldenId !== "string") return reply({ error: "choose_snapshot" }, 400);
          const golden = (await options.sessions.goldens(caller, orgId)).find((g) => g.id === body.goldenId);
          if (
            !golden ||
            !golden.config.repos.some(
              (r) => canonicalOttoRepository(r.url) === canonicalOttoRepository(thread.objective.repository),
            )
          )
            return reply({ error: "snapshot_unavailable" }, 422);
          const engine = (
            await sql.query<OttoEngine>(
              `select harness,model,credential_id as "credentialId" from public.otto_engine_preferences where org_id=$1 and owner_id=$2`,
              [orgId, caller.userId],
            )
          ).rows[0];
          if (!engine) return reply({ error: "choose_engine", connectUrl: "/otto/engine" }, 422);
          const preflight = await preflightOttoEngine(
            options.reader,
            options.key,
            { userId: caller.userId, orgId },
            engine,
          );
          if (!preflight.ready) return reply({ preflight }, 422);
          interview = await store.start(engine, golden.id);
        }
        const effect = await options.sessions.start(caller, scope, interview);
        const current = await store.read();
        if (!current) throw Error("Interview unavailable");
        // A bound ID alone is not launch success; never message an uncertain allocation.
        if ((effect as { status?: string }).status !== "succeeded") return reply({ interview: current, effect }, 202);
        return reply({ interview: current, effect: await options.sessions.message(caller, scope, current) }, 202);
      }
      if (!interview) return reply({ error: "start_interview_first" }, 409);
      if (body.action === "reopen") {
        if (body.revision !== interview.revision || typeof body.decisionId !== "string")
          return reply({ error: "invalid_reopen" }, 409);
        return reply({ interview: await store.reopenDecision(interview.revision, body.decisionId) }, 202);
      }
      const preflight = await preflightOttoEngine(
        options.reader,
        options.key,
        { userId: caller.userId, orgId },
        interview.engine,
      );
      if (!preflight.ready) return reply({ preflight }, 422);
      if (body.action === "restart") {
        if (body.revision !== interview.revision) return reply({ error: "interview_revision_conflict" }, 409);
        interview = await options.sessions.restart(caller, scope, interview);
        const effect = await options.sessions.start(caller, scope, interview);
        const current = await store.read();
        if (!current || (effect as { status?: string }).status !== "succeeded")
          return reply({ interview: current, effect }, 202);
        return reply({ interview: current, effect: await options.sessions.message(caller, scope, current) }, 202);
      }
      if (body.action === "answer") {
        if (
          !Number.isSafeInteger(body.revision) ||
          typeof body.body !== "string" ||
          !body.body.trim() ||
          body.body.length > 20000 ||
          typeof body.enough !== "boolean"
        )
          return reply({ error: "invalid_answer" }, 400);
        interview = await store.answer(
          body.revision as number,
          body.body,
          body.enough || /^enough[,\s]+go[.!]?$/i.test(body.body.trim()),
        );
      } else if (body.action !== "resume") return reply({ error: "invalid_action" }, 400);
      return reply({ interview, effect: await options.sessions.message(caller, scope, interview) }, 202);
    } catch {
      return reply(
        {
          error: "interview_unavailable",
          message: "Refresh to inspect saved state. An uncertain effect is never retried automatically.",
        },
        503,
      );
    }
  };
}
async function engineTools(
  options: OttoInterviewToolsOptions,
  request: Request,
  objectiveId: string,
): Promise<Response> {
  if (!options.key) return reply({ error: "unavailable" }, 503);
  if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  const row = (
    await options.sql.query<{
      org_id: string;
      owner_id: string;
      sandbox_id: string;
      role: Caller["orgs"][number]["role"];
      repository: string;
    }>(
      `select i.org_id,i.owner_id,i.snapshot->>'sandboxId' as sandbox_id,m.role,o.repository
    from public.otto_interviews i join public.otto_objectives o on o.id=i.objective_id and o.org_id=i.org_id and o.owner_id=i.owner_id
    join public.members m on m.org_id=i.org_id and m.user_id=i.owner_id
    join public.sandboxes s on s.id=(i.snapshot->>'sandboxId')::uuid and s.owner_id=i.owner_id and s.org_id=i.org_id
    where i.objective_id=$1 and s.status in ('ready','running') and s.deleted_at is null and s.stop_requested_at is null and s.expires_at>now()`,
      [objectiveId],
    )
  ).rows[0];
  if (!row) return reply({ error: "forbidden" }, 403);
  const scope: OttoInterviewScope = { orgId: row.org_id, ownerId: row.owner_id, objectiveId };
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const expected = interviewCapability(options.key, scope, row.sandbox_id);
  if (!/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(expected)))
    return reply({ error: "forbidden" }, 403);
  const caller: Caller = { userId: row.owner_id, orgs: [{ orgId: row.org_id, role: row.role }], via: "mcp" };
  if (
    !(await resolveOttoRepositories(options.sql, caller, row.org_id)).includes(
      canonicalOttoRepository(row.repository) ?? "",
    )
  )
    return reply({ error: "forbidden" }, 403);
  const store = interviewStore(options.sql, scope);
  const server = new McpServer({ name: "otto-interview", version: VERSION });
  const tools = {
    read_interview: {
      schema: z.object({}).strict(),
      run: async () => ({
        thread: await objectiveStore(options.sql, caller, row.org_id).thread(objectiveId),
        interview: await store.read(),
      }),
    },
    publish_round: {
      schema: z.object({ revision: z.number().int().positive(), round: roundSchema }).strict(),
      run: async (input: unknown) => {
        const args = z.object({ revision: z.number(), round: roundSchema }).parse(input);
        return store.publish(args.revision, args.round);
      },
    },
    read_repository_file: {
      schema: z.object({ path: z.string().min(1).max(1000) }).strict(),
      run: async (input: unknown) => {
        const { path } = z.object({ path: z.string() }).parse(input);
        if (
          !options.readFile ||
          path.startsWith("/") ||
          path.split("/").some((p) => p === ".." || p === "." || !p) ||
          /[\0?#\\]/.test(path)
        )
          throw Error("Invalid repository path");
        return options.readFile(caller, row.repository, path);
      },
    },
  };
  const raw = await readBody(request),
    rpc = JSON.parse(raw) as { method?: string; params?: { name?: string; arguments?: unknown } };
  if (rpc.method === "tools/call") {
    const tool = tools[rpc.params?.name as keyof typeof tools];
    if (!tool || !tool.schema.safeParse(rpc.params?.arguments).success) return reply({ error: "invalid_tool" }, 400);
  }
  for (const [name, tool] of Object.entries(tools))
    server.registerTool(
      name,
      {
        inputSchema: tool.schema,
        description:
          "Scoped interview state or read-only repository fact. No launch, GitHub write or completion authority.",
      },
      async (args: unknown) => {
        try {
          return { content: [{ type: "text" as const, text: JSON.stringify(await tool.run(args)) }] };
        } catch {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Interview conflict or unavailable fact. Read current state before continuing.",
              },
            ],
          };
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
}

/** GitHub access stays on the server; the engine receives only the requested file and its source. */
export function createOttoRepositoryFileReader(
  access: (caller: Caller) => Promise<import("@armada/core").GitHubAccess>,
  fetchFile: (url: URL, init: RequestInit) => Promise<Response> = globalThis.fetch,
): NonNullable<OttoInterviewToolsOptions["readFile"]> {
  return async (caller, repository, path) => {
    const github = await access(caller);
    if (github.status !== "connected") throw Error("Repository access unavailable");
    const url = new URL(
      `https://api.github.com/repos/${repository}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
    );
    const response = await fetchFile(url, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${github.token}`, accept: "application/vnd.github+json" },
    });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 250000)
      throw Error("Repository file unavailable");
    const file = JSON.parse(await readBody(response)) as {
      type?: string;
      encoding?: string;
      size?: number;
      content?: string;
      html_url?: string;
    };
    if (
      file.type !== "file" ||
      file.encoding !== "base64" ||
      typeof file.content !== "string" ||
      (file.size ?? Infinity) > 100000
    )
      throw Error("Select a text file under 100 KB");
    return {
      text: Buffer.from(file.content, "base64").toString("utf8"),
      source: file.html_url ?? `https://github.com/${repository}`,
    };
  };
}
