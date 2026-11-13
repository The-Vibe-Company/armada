import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_LAUNCH_TTL_SECONDS,
  type DockerLaunchResult,
  type DockerSandboxRecord,
  type GoldenActor,
  type GoldenRepo,
  HARNESSES,
  type Harness,
  type LaunchCredentialResolver,
  normalizeGitHubGoldenConfig,
  ProviderError,
  parseGoldenConfig,
  parseReadableVariableBindings,
  type ReadableVariableBinding,
  resolveModelChoice,
  type Sql,
} from "@armada/core";
import { createSqlSandboxStore, decryptSecret, encryptSecret, resolveLaunchVariables } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import type { createDockerBootstrapService } from "./docker-bootstrap-service.ts";
import { createDockerLaunchVariables } from "./docker-launch-variables.ts";
import { createDockerRuntimeLifecycle } from "./docker-runtime-lifecycle.ts";
import { createDockerSandboxService } from "./docker-sandbox-service.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";

type Request = {
  repos?: GoldenRepo[];
  variables?: ReadableVariableBinding[];
  org: string;
  provider: "docker";
  harness: Harness;
  visibility: "private";
  hostId: string;
  image: string;
  credentialId: string;
  credentialVersion: number | null;
  requestId: string;
  model: string;
  reasoningEffort: string;
  ttlSeconds: number;
  prompt: string | null;
};
type Manifest = {
  variables?: Record<string, string>;
  request: Request;
  credentialVersion: number;
  bootstrapId: string;
  healthId: string;
  promptId: string;
};
type Receipt = {
  epoch: string;
  promptId?: string;
  conversationId?: string;
  github?: { status: "connected"; login: string };
};
type Claim = {
  actor_epoch: string;
  request_hash: string;
  request_enc: Uint8Array<ArrayBuffer>;
  result_enc: Uint8Array<ArrayBuffer> | null;
};
type Row = {
  id: string;
  org_id: string;
  owner_id: string;
  provider: string;
  harness: Harness;
  provider_sandbox_id: string;
  docker_host_id: string;
  docker_image: string;
  status: DockerSandboxRecord["status"];
  conversation_ids: string[];
  created_at: Date | string;
  stopped_at: Date | string | null;
  deleted_at: Date | string | null;
  stop_requested_at: Date | string | null;
  expires_at: Date | string;
  effective_ttl_seconds: number;
  lifecycle_generation: string | number;
  expired: boolean;
  requested_ttl_seconds: number | null;
  credential_id: string;
  credential_version: number;
  model: string;
  reasoning_effort: string;
};
type Clock = { now(): number; wait(ms: number): Promise<void> };
type Options = {
  enabled?: boolean;
  github?: Pick<RuntimeGitHub, "prepare" | "preflightRepositories">;
  credentials: Pick<LaunchCredentialResolver, "resolve">;
  bootstrap?: ReturnType<typeof createDockerBootstrapService>;
  clock?: Clock;
  timeoutMs?: number;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function failure(code: "invalid_request" | "not_found" | "conflict" | "unavailable" | "sandbox_not_ready") {
  const messages = {
    invalid_request: "Invalid Docker launch request.",
    not_found: "Docker launch not found.",
    conflict: "Docker launch request conflicts with its original admission.",
    unavailable: "Docker launch is unavailable. Retry the same request without changes.",
    sandbox_not_ready: "Docker sandbox did not become ready. Inspect its status before cleanup.",
  };
  return new ProviderError({
    provider: "docker",
    code,
    message: messages[code],
    retryable: code === "unavailable",
    // Retain the dashboard replay key for unknown outcomes, including lost commits.
    ...(code === "unavailable" ? { details: { resourceReceipt: true } } : {}),
  });
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw failure("invalid_request");
  return value.toLowerCase();
}
function normalize(body: Record<string, unknown>): Request {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (field) =>
        ![
          "repos",
          "variables",
          "org",
          "provider",
          "hostId",
          "image",
          "harness",
          "credentialId",
          "credentialVersion",
          "requestId",
          "model",
          "reasoningEffort",
          "prompt",
          "ttlSeconds",
          "visibility",
        ].includes(field),
    ) ||
    body.provider !== "docker" ||
    !HARNESSES.includes(body.harness as Harness) ||
    (body.visibility !== undefined && body.visibility !== "private") ||
    typeof body.image !== "string" ||
    body.image.length > 512 ||
    !/^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/.test(body.image) ||
    (body.credentialVersion !== undefined &&
      (!Number.isSafeInteger(body.credentialVersion) || (body.credentialVersion as number) < 1)) ||
    (body.model !== undefined && typeof body.model !== "string") ||
    (body.reasoningEffort !== undefined && typeof body.reasoningEffort !== "string") ||
    (body.prompt !== undefined &&
      (typeof body.prompt !== "string" || !body.prompt.trim() || Buffer.byteLength(body.prompt) > 262144))
  )
    throw failure("invalid_request");
  const ttlSeconds = body.ttlSeconds === undefined ? DEFAULT_LAUNCH_TTL_SECONDS : body.ttlSeconds;
  if (typeof ttlSeconds !== "number" || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400)
    throw failure("invalid_request");
  let choice: ReturnType<typeof resolveModelChoice>;
  try {
    choice = resolveModelChoice(body.harness as Harness, {
      model: body.model as string | undefined,
      reasoningEffort: body.reasoningEffort as string | undefined,
    });
  } catch {
    throw failure("invalid_request");
  }
  let variables: ReadableVariableBinding[] | undefined;
  if (body.variables !== undefined) {
    try {
      variables = parseReadableVariableBindings(body.variables);
    } catch {
      throw failure("invalid_request");
    }
  }
  let repos: GoldenRepo[] | undefined;
  if (body.repos !== undefined) {
    try {
      const config = parseGoldenConfig({ repos: body.repos, init: [] });
      repos = normalizeGitHubGoldenConfig(config).repos.map((r) => ({
        url: `https://github.com/${r.owner}/${r.repo}.git`,
        branch: r.branch,
        dir: r.dir,
      }));
    } catch {
      throw failure("invalid_request");
    }
  }
  return {
    ...(repos ? { repos } : {}),
    ...(variables ? { variables } : {}),
    org: identifier(body.org),
    provider: "docker",
    harness: body.harness as Harness,
    visibility: "private",
    hostId: identifier(body.hostId),
    image: body.image,
    credentialId: identifier(body.credentialId),
    credentialVersion: (body.credentialVersion as number | undefined) ?? null,
    requestId: identifier(body.requestId),
    model: choice.model,
    reasoningEffort: choice.reasoningEffort,
    ttlSeconds,
    prompt: (body.prompt as string | undefined) ?? null,
  };
}
const scoped = (tx: Sql): Sql => ({ query: tx.query.bind(tx), transaction: (work) => work(tx) });
const iso = (date: Date | string) => new Date(date).toISOString();
const active = (row: Row) =>
  ["starting", "ready", "running"].includes(row.status) &&
  row.stop_requested_at === null &&
  row.deleted_at === null &&
  !row.expired;

/** Durable normal launch composition. No SQL transaction spans resolution, waiting or runtime work. */
export function createDockerNormalLaunch(sql: Sql, key: string, options: Options) {
  const clock = options.clock ?? {
    now: Date.now,
    wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const sandboxes = createDockerSandboxService(sql, key, { enabled: true });
  const runtime = createDockerRuntimeLifecycle(sql, key, { enabled: true });
  async function transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    if (!sql.transaction) throw failure("unavailable");
    return sql.transaction(work);
  }
  async function member(tx: Sql, actor: { userId: string; orgId: string }) {
    const membership = (
      await tx.query<{ role: GoldenActor["role"]; epoch: string }>(
        `select m.role,e.epoch::text from public.members m join public.mcp_actor_epochs e using(org_id,user_id)
       where m.org_id=$1 and m.user_id=$2 for share of m`,
        [actor.orgId, actor.userId],
      )
    ).rows[0];
    if (!membership) throw failure("not_found");
    return membership;
  }
  async function load(tx: Sql, actor: { userId: string; orgId: string }, request: Request, hash: string) {
    const membership = await member(tx, actor);
    const row = (
      await tx.query<Row>(
        `select id,org_id,owner_id,provider,harness,provider_sandbox_id,docker_host_id,docker_image,status,
        conversation_ids,created_at,stopped_at,deleted_at,stop_requested_at,expires_at,effective_ttl_seconds,
        lifecycle_generation,requested_ttl_seconds,credential_id,credential_version,model,reasoning_effort,
        expires_at<=now() as expired from public.sandboxes where id=$1`,
        [request.requestId],
      )
    ).rows[0];
    if (!row) return { membership };
    if (row.owner_id !== actor.userId || row.org_id !== actor.orgId || row.provider !== "docker")
      throw failure("not_found");
    const claim = (
      await tx.query<Claim>(
        `select actor_epoch::text,request_hash,request_enc,result_enc from public.docker_launch_requests where sandbox_id=$1`,
        [row.id],
      )
    ).rows[0];
    if (!claim || claim.request_hash !== hash) throw failure("conflict");
    if (claim.actor_epoch !== membership.epoch) throw failure("not_found");
    const manifest = JSON.parse(await decryptSecret(claim.request_enc, key)) as Manifest;
    const receipt = claim.result_enc ? (JSON.parse(await decryptSecret(claim.result_enc, key)) as Receipt) : undefined;
    if (
      !manifest ||
      !manifest.request ||
      createHash("sha256").update(JSON.stringify(manifest.request)).digest("hex") !== hash ||
      !Number.isSafeInteger(manifest.credentialVersion) ||
      manifest.credentialVersion < 1 ||
      ![manifest.bootstrapId, manifest.healthId, manifest.promptId].every(
        (id) => typeof id === "string" && uuid.test(id),
      )
    )
      throw failure("conflict");
    if (
      claim.result_enc &&
      (!receipt ||
        typeof receipt.epoch !== "string" ||
        !/^[1-9][0-9]{0,18}$/.test(receipt.epoch) ||
        (receipt.promptId !== undefined && (typeof receipt.promptId !== "string" || !uuid.test(receipt.promptId))) ||
        (receipt.conversationId !== undefined &&
          (typeof receipt.conversationId !== "string" || !uuid.test(receipt.conversationId))) ||
        (receipt.promptId === undefined) !== (receipt.conversationId === undefined))
    )
      throw failure("conflict");
    return { membership, row, manifest, receipt };
  }
  function envelope(row: Row, receipt: Receipt): DockerLaunchResult {
    const sandbox: DockerSandboxRecord = {
      id: row.id,
      provider: "docker",
      providerSandboxId: row.provider_sandbox_id,
      goldenId: null,
      orgId: row.org_id,
      ownerId: row.owner_id,
      harness: row.harness,
      visibility: "private",
      hostId: row.docker_host_id,
      image: row.docker_image,
      status: row.status,
      conversationIds: row.conversation_ids,
      createdAt: iso(row.created_at),
      stoppedAt: row.stopped_at === null ? null : iso(row.stopped_at),
      deletedAt: row.deleted_at === null ? null : iso(row.deleted_at),
      stopRequestedAt: row.stop_requested_at === null ? null : iso(row.stop_requested_at),
      statusReason: row.status === "failed" ? "Docker sandbox failed." : null,
      repositoryDir: null,
      model: row.model,
      reasoningEffort: row.reasoning_effort,
      credentialId: row.credential_id,
      credentialVersion: row.credential_version,
      expiresAt: iso(row.expires_at),
      effectiveTtlSeconds: row.effective_ttl_seconds,
      requestedTtlSeconds: row.requested_ttl_seconds,
    };
    return {
      sandbox,
      golden: null,
      helper: null,
      github: receipt.github ?? { status: "unavailable", message: "GitHub is unavailable on Docker hosts." },
      runtime: { kind: "armada", epoch: receipt.epoch },
      ttlSeconds: row.effective_ttl_seconds,
      expiresAt: iso(row.expires_at),
      ...(receipt.promptId ? { promptId: receipt.promptId } : {}),
      ...(receipt.conversationId ? { conversationId: receipt.conversationId } : {}),
    };
  }
  return {
    async launch(caller: Caller, body: Record<string, unknown>): Promise<DockerLaunchResult> {
      try {
        const request = normalize(body);
        const actor = { userId: identifier(caller.userId), orgId: request.org };
        if (!caller.orgs.some((org) => org.orgId.toLowerCase() === request.org)) throw failure("not_found");
        const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
        let state = await transaction((tx) => load(tx, actor, request, hash));
        if (state.row && state.receipt) return envelope(state.row, state.receipt);
        if (options.enabled !== true || !options.bootstrap) throw failure("unavailable");
        if (!state.manifest) {
          if (request.repos) {
            if (!options.github) throw failure("unavailable");
            await options.github.preflightRepositories(caller, request.org, request.repos);
          }
          // Resolve outside the reservation transaction; only the binding is retained.
          const resolved = await options.credentials.resolve(
            { ...actor, role: state.membership.role },
            request.harness,
            request.credentialId,
            request.credentialVersion ?? undefined,
          );
          const binding = resolved.binding;
          if (
            !binding ||
            binding.credentialId !== request.credentialId ||
            !Number.isSafeInteger(binding.credentialVersion) ||
            binding.credentialVersion < 1 ||
            (request.credentialVersion !== null && binding.credentialVersion !== request.credentialVersion)
          )
            throw failure("not_found");
          const manifest: Manifest = {
            request,
            credentialVersion: binding.credentialVersion,
            bootstrapId: randomUUID(),
            healthId: randomUUID(),
            promptId: randomUUID(),
          };

          state = await transaction(async (tx) => {
            await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [
              `docker-normal-launch:${request.requestId}`,
            ]);
            // This existence read intentionally takes no member SHARE lock:
            // reserve owns the sorted member UPDATE/credential/host lock order.
            const exists =
              (await tx.query(`select id from public.sandboxes where id=$1`, [request.requestId])).rows.length > 0;
            if (exists) return load(tx, actor, request, hash);
            await createDockerSandboxService(scoped(tx), key, { enabled: true }).reserve(actor, {
              requestId: request.requestId,
              hostId: request.hostId,
              image: request.image,
              harness: request.harness,
              credentialId: request.credentialId,
              credentialVersion: manifest.credentialVersion,
              model: request.model,
              reasoningEffort: request.reasoningEffort,
              ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: request.ttlSeconds }),
            });
            if (resolved.usagePricing)
              await createSqlSandboxStore(scoped(tx), { turnModels: true }).recordUsagePricingContext?.(
                request.requestId,
                resolved.usagePricing,
              );
            if (request.variables?.length)
              manifest.variables = await resolveLaunchVariables(scoped(tx), actor, request.variables);
            const encrypted = await encryptSecret(JSON.stringify(manifest), key);
            const current = await member(tx, actor);
            await tx.query(
              `insert into public.docker_launch_requests(sandbox_id,actor_epoch,request_hash,request_enc) values($1,$2,$3,$4)`,
              [request.requestId, current.epoch, hash, encrypted],
            );
            return load(tx, actor, request, hash);
          });
        }
        if (state.row && state.receipt) return envelope(state.row, state.receipt);
        const manifest = state.manifest;
        if (!manifest) throw failure("unavailable");
        const deadline = clock.now() + (options.timeoutMs ?? 600_000);
        async function live() {
          const current = await transaction((tx) => load(tx, actor, request, hash));
          if (!current.row) throw failure("not_found");
          if (!active(current.row)) throw failure("sandbox_not_ready");
          return current;
        }
        async function wait() {
          if (clock.now() >= deadline) throw failure("unavailable");
          await clock.wait(Math.min(250, deadline - clock.now()));
        }
        async function acknowledged(id: string) {
          for (;;) {
            await live();
            const job = await sandboxes.job(actor, request.requestId, id);
            if (job?.state === "completed") return;
            if (job?.state === "failed") throw failure("sandbox_not_ready");
            await wait();
          }
        }
        await acknowledged(request.requestId);
        await live();
        await options.bootstrap.bootstrap(actor, request.requestId, manifest.bootstrapId);
        await acknowledged(manifest.bootstrapId);
        let receipt: Receipt;
        for (;;) {
          await live();
          const ready = await runtime.ready(actor, request.requestId, manifest.healthId);
          if (ready.state === "ready") {
            receipt = { epoch: ready.epoch };
            break;
          }
          await wait();
        }
        await createDockerLaunchVariables(sql, key, clock)(caller, request.requestId);
        if (manifest.request.repos) {
          if (!options.github) throw failure("unavailable");
          const github = await options.github.prepare(caller, request.requestId);
          receipt.github = { status: "connected", login: github.login };
          const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
          const command = [
            "set -euo pipefail",
            "export GIT_TERMINAL_PROMPT=0",
            ...manifest.request.repos.map(
              (repo) =>
                `git clone --single-branch --branch ${quote(repo.branch)} -- ${quote(repo.url)} ${quote(`/home/user/${repo.dir}`)}`,
            ),
          ].join("\n");
          const commands = createRuntimeCommands(createRuntimeEnrolments(sql, key), key);
          const id = `docker_checkout_${request.requestId}`;
          await commands.enqueue(
            actor.userId,
            {
              version: 1,
              requestId: id,
              sandboxId: request.requestId,
              op: "exec",
              input: { sandboxId: request.requestId, command, cwd: "/home/user", timeoutSeconds: 600 },
            },
            receipt.epoch,
          );
          for (;;) {
            await live();
            const response = await commands.result(actor.userId, request.requestId, id, receipt.epoch);
            if (response.state === "finished") {
              const result = response.reply.body.result as Record<string, unknown> | undefined;
              if (
                response.reply.status !== 200 ||
                !result ||
                result.detached !== false ||
                result.exitCode !== 0 ||
                result.timedOut !== false
              )
                throw failure("sandbox_not_ready");
              break;
            }
            if (response.state !== "pending") throw failure("sandbox_not_ready");
            await wait();
          }
        }
        if (manifest.request.prompt !== null) {
          for (;;) {
            await live();
            const result = await runtime.prompt(actor, request.requestId, {
              requestId: manifest.promptId,
              text: manifest.request.prompt,
            });
            if (result.state === "admitted") {
              if (result.epoch !== receipt.epoch) throw failure("sandbox_not_ready");
              receipt = {
                ...receipt,
                epoch: result.epoch,
                promptId: result.receipt.promptId,
                conversationId: result.receipt.conversationId,
              };
              break;
            }
            await wait();
          }
        }
        const encrypted = await encryptSecret(JSON.stringify(receipt), key);
        return await transaction(async (tx) => {
          const authority = createRuntimeEnrolments(scoped(tx), key);
          // All source actors precede host/sandbox/runtime locks. The transport
          // epoch and logical lifecycle generation are independent counters.
          await authority.lockSourceMembers(tx, request.requestId, actor.userId);
          const current = await load(tx, actor, request, hash);
          if (!current.row) throw failure("not_found");
          if (current.receipt) return envelope(current.row, current.receipt);
          if (!active(current.row)) throw failure("sandbox_not_ready");
          await authority.withOwner(request.requestId, actor.userId, async (_tx, scope) => {
            if (scope.epoch !== receipt.epoch) throw failure("sandbox_not_ready");
            await tx.query(
              `update public.docker_launch_requests set result_enc=$2 where sandbox_id=$1 and result_enc is null`,
              [request.requestId, encrypted],
            );
          });
          const saved = await load(tx, actor, request, hash);
          if (!saved.row || !saved.receipt) throw failure("unavailable");
          return envelope(saved.row, saved.receipt);
        });
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw failure("unavailable");
      }
    },
  };
}

export type DockerNormalLaunch = ReturnType<typeof createDockerNormalLaunch>;
