import { randomUUID } from "node:crypto";
import {
  type ApplicationSecretBinding,
  DEFAULT_LAUNCH_TTL_SECONDS,
  DOCKER_IMAGE_UNAVAILABLE_MESSAGE,
  DOCKER_LAUNCH_FAILURE_MESSAGES,
  type DockerLaunchResult,
  type DockerSandboxRecord,
  type GitHubLaunchInfo,
  type GoldenActor,
  type GoldenRepo,
  HARNESSES,
  type Harness,
  type LaunchCredentialResolver,
  normalizeGitHubGoldenConfig,
  officialSandboxImage,
  ProviderError,
  parseApplicationSecretBindings,
  parseGoldenConfig,
  parseReadableVariableBindings,
  type ReadableVariableBinding,
  resolveModelChoice,
  type SkillReceipt,
  type Sql,
  VaultError,
  validateReadableVariables,
  validateSkillPins,
} from "@armada/core";
import {
  createSkillDefaultsService,
  createSqlMcpLaunchPort,
  createSqlMcpRegistry,
  createSqlSandboxStore,
  decryptSecret,
  encryptSecret,
  mergeSkillPins,
  resolveLaunchSecrets,
  resolveLaunchVariables,
} from "@armada/core/server";
import type { Caller } from "./caller.ts";
import type { createDockerBootstrapService } from "./docker-bootstrap-service.ts";
import { createDockerLaunchEnvironment } from "./docker-launch-environment.ts";
import { dockerLaunchRequestHash, matchesDockerLaunchRequestHash } from "./docker-launch-identity.ts";
import { createDockerRuntimeLifecycle } from "./docker-runtime-lifecycle.ts";
import { createDockerSandboxService } from "./docker-sandbox-service.ts";
import { resolveDockerSnapshot } from "./docker-snapshot-data.ts";
import { createRuntimeAgent } from "./runtime-agent.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import { type RuntimeGitHub, RuntimeGitHubDeliveryError } from "./runtime-github.ts";
import type { RuntimeMcp } from "./runtime-mcp.ts";

type Request = {
  repos?: GoldenRepo[];
  variables?: ReadableVariableBinding[];
  secrets?: ApplicationSecretBinding[];
  snapshotId?: string;
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
  skills?: string[];
  connections?: string[];
  skipSkillDefaults?: boolean;
};
type Manifest = {
  variables?: Record<string, string>;
  snapshotConfig?: import("@armada/core").GoldenConfig;
  request: Request;
  credentialVersion: number;
  bootstrapId: string;
  healthId: string;
  promptId: string;
  preparation?: { skills: string[]; connections: string[] };
};
type Receipt = {
  epoch: string;
  promptId?: string;
  conversationId?: string;
  github?: GitHubLaunchInfo;
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
  docker_snapshot_id: string | null;
  status: DockerSandboxRecord["status"];
  status_reason: string | null;
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
  skills: SkillReceipt[];
};
type Clock = { now(): number; wait(ms: number): Promise<void> };
type Options = {
  enabled?: boolean;
  /** Normal owner launches return their durable reservation; a server worker completes preparation. */
  deferLaunch?: boolean;
  /** Trusted server release configuration, never accepted from a caller. */
  officialImage?: string;
  github?: Pick<RuntimeGitHub, "prepare" | "prepareLaunch" | "preflightRepositories">;
  credentials: Pick<LaunchCredentialResolver, "resolve" | "skillpackKey">;
  mcp?: RuntimeMcp;
  bootstrap?: ReturnType<typeof createDockerBootstrapService>;
  clock?: Clock;
  timeoutMs?: number;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function failure(
  code: "invalid_request" | "not_found" | "conflict" | "unavailable" | "sandbox_not_ready",
  message?: string,
) {
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
    message: message ?? messages[code],
    retryable: code === "unavailable",
    // Retain the dashboard replay key for unknown outcomes, including lost commits.
    ...(code === "unavailable" ? { details: { resourceReceipt: true } } : {}),
  });
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw failure("invalid_request");
  return value.toLowerCase();
}
function normalize(body: Record<string, unknown>, image: string): Request {
  if (body && typeof body === "object" && Object.hasOwn(body, "image"))
    throw failure(
      "invalid_request",
      "Remove the image field and retry. Armada chooses the Docker environment automatically.",
    );
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (field) =>
        ![
          "repos",
          "variables",
          "secrets",
          "snapshotId",
          "org",
          "provider",
          "hostId",
          "harness",
          "credentialId",
          "credentialVersion",
          "requestId",
          "model",
          "reasoningEffort",
          "prompt",
          "ttlSeconds",
          "visibility",
          "skills",
          "connections",
          "skipSkillDefaults",
        ].includes(field),
    ) ||
    body.provider !== "docker" ||
    !HARNESSES.includes(body.harness as Harness) ||
    (body.visibility !== undefined && body.visibility !== "private") ||
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
  if (body.skipSkillDefaults !== undefined && typeof body.skipSkillDefaults !== "boolean")
    throw failure("invalid_request");
  if (body.skills !== undefined) {
    try {
      validateSkillPins(body.skills);
    } catch {
      throw failure("invalid_request");
    }
  }
  if (
    body.connections !== undefined &&
    (!Array.isArray(body.connections) ||
      body.connections.length > 32 ||
      body.connections.some((id) => typeof id !== "string" || !uuid.test(id)))
  )
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
  let secrets: ApplicationSecretBinding[] | undefined;
  if (body.secrets !== undefined) {
    try {
      secrets = parseApplicationSecretBindings(body.secrets);
    } catch {
      throw failure("invalid_request");
    }
  }
  if (
    (variables?.length ?? 0) + (secrets?.length ?? 0) > 64 ||
    secrets?.some((secret) => variables?.some((variable) => variable.key === secret.key))
  )
    throw failure("invalid_request");
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
    ...(secrets ? { secrets } : {}),
    ...(body.snapshotId === undefined ? {} : { snapshotId: identifier(body.snapshotId) }),
    org: identifier(body.org),
    provider: "docker",
    harness: body.harness as Harness,
    visibility: "private",
    hostId: identifier(body.hostId),
    image,
    credentialId: identifier(body.credentialId),
    credentialVersion: (body.credentialVersion as number | undefined) ?? null,
    requestId: identifier(body.requestId),
    model: choice.model,
    reasoningEffort: choice.reasoningEffort,
    ttlSeconds,
    prompt: (body.prompt as string | undefined) ?? null,
    ...(body.skills === undefined ? {} : { skills: [...(body.skills as string[])] }),
    ...(body.skipSkillDefaults === undefined ? {} : { skipSkillDefaults: body.skipSkillDefaults as boolean }),
    ...(body.connections === undefined
      ? {}
      : { connections: [...new Set((body.connections as string[]).map((id) => id.toLowerCase()))].sort() }),
  };
}
/** A launch that did not become ready, in the host's own words when it could not fetch the image (#1507). */
const notReady = (row: Row) =>
  failure(
    "sandbox_not_ready",
    row.status_reason === DOCKER_IMAGE_UNAVAILABLE_MESSAGE ||
      Object.values(DOCKER_LAUNCH_FAILURE_MESSAGES).some((message) => message === row.status_reason)
      ? DOCKER_IMAGE_UNAVAILABLE_MESSAGE
      : undefined,
  );
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
        `select id,org_id,owner_id,provider,harness,provider_sandbox_id,docker_host_id,docker_image,docker_snapshot_id,status,status_reason,
        conversation_ids,created_at,stopped_at,deleted_at,stop_requested_at,expires_at,effective_ttl_seconds,
        lifecycle_generation,requested_ttl_seconds,credential_id,credential_version,model,reasoning_effort,skills,
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
    if (!claim) throw failure("conflict");
    if (claim.actor_epoch !== membership.epoch) throw failure("not_found");
    const manifest = JSON.parse(await decryptSecret(claim.request_enc, key)) as Manifest;
    const receipt = claim.result_enc ? (JSON.parse(await decryptSecret(claim.result_enc, key)) as Receipt) : undefined;
    if (
      !manifest ||
      !manifest.request ||
      !matchesDockerLaunchRequestHash(manifest.request, claim.request_hash) ||
      dockerLaunchRequestHash(manifest.request) !== hash ||
      !Number.isSafeInteger(manifest.credentialVersion) ||
      manifest.credentialVersion < 1 ||
      ![manifest.bootstrapId, manifest.healthId, manifest.promptId].every(
        (id) => typeof id === "string" && uuid.test(id),
      )
    )
      throw failure("conflict");
    if (manifest.preparation !== undefined) {
      try {
        validateSkillPins(manifest.preparation.skills);
      } catch {
        throw failure("conflict");
      }
      if (
        !Array.isArray(manifest.preparation.connections) ||
        manifest.preparation.connections.length > 32 ||
        manifest.preparation.connections.some((id) => typeof id !== "string" || !uuid.test(id))
      )
        throw failure("conflict");
    } else if (manifest.request.skills !== undefined || manifest.request.connections !== undefined)
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
  function envelope(row: Row, receipt?: Receipt): DockerLaunchResult {
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
      snapshotId: row.docker_snapshot_id,
      status: !receipt && ["ready", "running"].includes(row.status) ? "starting" : row.status,
      conversationIds: row.conversation_ids,
      createdAt: iso(row.created_at),
      stoppedAt: row.stopped_at === null ? null : iso(row.stopped_at),
      deletedAt: row.deleted_at === null ? null : iso(row.deleted_at),
      stopRequestedAt: row.stop_requested_at === null ? null : iso(row.stop_requested_at),
      statusReason:
        row.status !== "failed"
          ? null
          : row.status_reason === DOCKER_IMAGE_UNAVAILABLE_MESSAGE ||
              Object.values(DOCKER_LAUNCH_FAILURE_MESSAGES).some((message) => message === row.status_reason)
            ? row.status_reason
            : "Docker sandbox failed.",
      repositoryDir: null,
      model: row.model,
      reasoningEffort: row.reasoning_effort,
      credentialId: row.credential_id,
      credentialVersion: row.credential_version,
      expiresAt: iso(row.expires_at),
      effectiveTtlSeconds: row.effective_ttl_seconds,
      requestedTtlSeconds: row.requested_ttl_seconds,
      skills: row.skills ?? [],
    };
    return {
      sandbox,
      golden: null,
      helper: null,
      github: receipt?.github ?? { status: "unavailable", message: "GitHub is unavailable on Docker hosts." },
      runtime: receipt ? { kind: "armada", epoch: receipt.epoch } : null,
      ttlSeconds: row.effective_ttl_seconds,
      expiresAt: iso(row.expires_at),
      ...(receipt?.promptId ? { promptId: receipt.promptId } : {}),
      ...(receipt?.conversationId ? { conversationId: receipt.conversationId } : {}),
    };
  }
  async function launch(
    caller: Caller,
    body: Record<string, unknown>,
    admission?: {
      beforeReserve(tx: Sql): Promise<void>;
      beforeStart(): Promise<void>;
    },
    workerId?: string,
  ): Promise<DockerLaunchResult> {
    try {
      const snapshotId = body.snapshotId === undefined ? undefined : identifier(body.snapshotId);
      if (snapshotId && (body.image !== undefined || body.repos !== undefined)) throw failure("invalid_request");
      const org = identifier(body.org);
      if (!caller.orgs.some((member) => member.orgId === org)) throw failure("not_found");
      const retained = snapshotId
        ? (
            await sql.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
              `select d.request_enc from public.docker_launch_requests d join public.sandboxes s on s.id=d.sandbox_id
           join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
           join public.mcp_actor_epochs e on e.org_id=s.org_id and e.user_id=s.owner_id and e.epoch=d.actor_epoch
           where s.id=$1 and s.owner_id=$2 and s.org_id=$3 and s.provider='docker' and s.docker_snapshot_id=$4`,
              [identifier(body.requestId), caller.userId, org, snapshotId],
            )
          ).rows[0]
        : undefined;
      const frozen = retained
        ? (JSON.parse(await decryptSecret(retained.request_enc, key)) as Manifest).request
        : undefined;
      const source =
        snapshotId && !frozen
          ? await resolveDockerSnapshot(sql, { userId: caller.userId, orgId: org }, snapshotId)
          : undefined;
      const sourceHost = frozen?.hostId ?? source?.host_id,
        sourceImage = frozen?.image ?? source?.image_id;
      if (sourceHost && body.hostId !== undefined && identifier(body.hostId) !== sourceHost) throw failure("not_found");
      let image: string;
      try {
        image = sourceImage ?? options.officialImage ?? officialSandboxImage();
      } catch {
        throw new ProviderError({
          provider: "docker",
          code: "provider_not_configured",
          retryable: false,
          message:
            "Armada's sandbox image configuration is invalid. Ask the server operator to deploy a matching release image pin. No sandbox was created.",
        });
      }
      const request = normalize(sourceHost ? { ...body, hostId: sourceHost } : body, image);
      const actor = { userId: identifier(caller.userId), orgId: request.org };
      if (!caller.orgs.some((org) => org.orgId.toLowerCase() === request.org)) throw failure("not_found");
      const hash = dockerLaunchRequestHash(request);
      let state = await transaction((tx) => load(tx, actor, request, hash));
      if (state.row && state.receipt) return envelope(state.row, state.receipt);
      if (options.enabled !== true || !options.bootstrap) throw failure("unavailable");
      if (!state.manifest) {
        if (request.repos && (!options.deferLaunch || admission)) {
          if (!options.github) throw failure("unavailable");
          await options.github.preflightRepositories(caller, request.org, request.repos ?? source?.config.repos ?? []);
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
        const launchActor = { ...actor, role: state.membership.role };
        const defaults = request.skipSkillDefaults
          ? { org: [], personal: [] }
          : await createSkillDefaultsService(sql).resolve(launchActor, null);
        let skills: string[];
        try {
          skills = mergeSkillPins(defaults.org, defaults.personal, request.skills ?? []);
        } catch {
          throw failure("invalid_request");
        }
        const connections =
          request.connections ??
          (await createSqlMcpLaunchPort(sql, createSqlMcpRegistry(sql, key)).defaults(actor, "private"));
        if (connections.length) {
          if (!options.mcp) throw failure("unavailable");
          await options.mcp.connections.validate(actor, connections, "private");
        }
        const manifest: Manifest = {
          ...(source ? { snapshotConfig: source.config } : {}),
          request,
          credentialVersion: binding.credentialVersion,
          bootstrapId: randomUUID(),
          healthId: randomUUID(),
          promptId: randomUUID(),
          preparation: { skills, connections },
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
          await createDockerSandboxService(scoped(tx), key, { enabled: true }).reserve(
            actor,
            {
              requestId: request.requestId,
              hostId: request.hostId,
              image: request.image,
              harness: request.harness,
              credentialId: request.credentialId,
              credentialVersion: manifest.credentialVersion,
              model: request.model,
              reasoningEffort: request.reasoningEffort,
              ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: request.ttlSeconds }),
            },
            admission?.beforeReserve,
            snapshotId,
          );
          if (resolved.usagePricing)
            await createSqlSandboxStore(scoped(tx), { turnModels: true }).recordUsagePricingContext?.(
              request.requestId,
              resolved.usagePricing,
            );
          try {
            if (request.variables?.length)
              manifest.variables = await resolveLaunchVariables(scoped(tx), actor, request.variables);
            if (request.secrets?.length)
              validateReadableVariables({
                ...manifest.variables,
                ...(await resolveLaunchSecrets(scoped(tx), actor, request.secrets, key)),
              });
          } catch {
            throw failure("unavailable");
          }
          const encrypted = await encryptSecret(JSON.stringify(manifest), key);
          const connections = manifest.preparation?.connections ?? [];
          const port = createSqlMcpLaunchPort(scoped(tx), createSqlMcpRegistry(scoped(tx), key));
          await port.validate(actor, connections, "private");
          await port.bind(request.requestId, connections);
          const current = await member(tx, actor);
          await tx.query(
            `insert into public.docker_launch_requests(sandbox_id,actor_epoch,request_hash,request_enc,async_launch) values($1,$2,$3,$4,$5)`,
            [request.requestId, current.epoch, hash, encrypted, options.deferLaunch === true && !admission],
          );
          return load(tx, actor, request, hash);
        });
      }
      if (state.row && state.receipt) return envelope(state.row, state.receipt);
      const manifest = state.manifest;
      if (!manifest || !state.row) throw failure("unavailable");
      if (options.deferLaunch && !admission && !workerId) return envelope(state.row);
      let phase: string = DOCKER_LAUNCH_FAILURE_MESSAGES.startup;
      try {
        if (workerId && request.repos) {
          phase = DOCKER_LAUNCH_FAILURE_MESSAGES.github;
          if (!options.github) throw failure("unavailable");
          await options.github.preflightRepositories(caller, request.org, request.repos);
        }
        phase = DOCKER_LAUNCH_FAILURE_MESSAGES.startup;
        const deadline = clock.now() + (options.timeoutMs ?? 600_000);
        async function live() {
          if (workerId) {
            const lease = await sql.query(
              `select sandbox_id from public.docker_launch_requests where sandbox_id=$1 and worker_id=$2 and worker_expires_at>now()`,
              [request.requestId, workerId],
            );
            if (!lease.rows.length || stopping) throw failure("unavailable");
          }
          const current = await transaction((tx) => load(tx, actor, request, hash));
          if (!current.row) throw failure("not_found");
          if (!active(current.row)) throw notReady(current.row);
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
            if (job?.state === "failed") throw notReady((await live()).row);
            await wait();
          }
        }
        await acknowledged(request.requestId);
        await live();
        await admission?.beforeStart();
        await options.bootstrap.bootstrap(actor, request.requestId, manifest.bootstrapId);
        await acknowledged(manifest.bootstrapId);
        let receipt: Receipt;
        for (;;) {
          await live();
          const ready = await runtime.ready(actor, request.requestId, manifest.healthId, false);
          if (ready.state === "ready") {
            receipt = { epoch: ready.epoch };
            break;
          }
          await wait();
        }
        phase = DOCKER_LAUNCH_FAILURE_MESSAGES.environment;
        await createDockerLaunchEnvironment(sql, key, clock)(caller, request.requestId);
        phase = DOCKER_LAUNCH_FAILURE_MESSAGES.github;
        if (!manifest.request.repos && manifest.snapshotConfig?.repos.length && options.github)
          receipt.github = await options.github.prepareLaunch(caller, request.requestId);
        if (manifest.request.repos) {
          if (!options.github) throw failure("unavailable");
          const github = await options.github.prepare(caller, request.requestId);
          receipt.github = { status: "connected", login: github.login };
          if (manifest.request.repos) {
            phase = DOCKER_LAUNCH_FAILURE_MESSAGES.checkout;
            const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
            const command = [
              "set -euo pipefail",
              "export GIT_TERMINAL_PROMPT=0",
              ...manifest.request.repos.map(
                (repo) =>
                  `git clone --depth=1 --single-branch --branch ${quote(repo.branch)} -- ${quote(repo.url)} ${quote(`/home/user/${repo.dir}`)}`,
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
        }
        phase = DOCKER_LAUNCH_FAILURE_MESSAGES.preparation;
        const selections = manifest.preparation;
        if (selections?.skills.length) {
          const needsKey = selections.skills.some((reference) => !reference.includes("/"));
          const skillKey = needsKey
            ? ((await options.credentials.skillpackKey?.({ ...actor, role: state.membership.role })) ?? null)
            : null;
          if (needsKey && !skillKey) throw failure("unavailable");
          const agent = createRuntimeAgent(
            createRuntimeCommands(createRuntimeEnrolments(sql, key), key, {
              now: clock.now,
              wait: (ms) => clock.wait(ms),
            }),
            {
              harness: request.harness,
              ownerId: actor.userId,
              sandboxId: request.requestId,
              providerSandboxId: request.requestId,
              cwd: "/home/user",
              defaults: { model: request.model, reasoningEffort: request.reasoningEffort },
            },
          );
          const receipts = await agent.installSkills(selections.skills, skillKey, receipt.epoch);
          await createRuntimeEnrolments(sql, key).withOwner(request.requestId, actor.userId, async (tx, scope) => {
            if (scope.epoch !== receipt.epoch) throw failure("sandbox_not_ready");
            await createSqlSandboxStore(scoped(tx)).recordSkills!(request.requestId, receipts);
          });
        }
        if (options.mcp) await options.mcp.prepare(caller, request.requestId);
        else if (selections?.connections.length) throw failure("unavailable");
        await live();
        await createRuntimeEnrolments(sql, key).withOwner(request.requestId, actor.userId, async (tx, scope) => {
          if (scope.epoch !== receipt.epoch) throw failure("sandbox_not_ready");
          await tx.query(`update public.sandboxes set status='ready' where id=$1 and status='starting'`, [
            request.requestId,
          ]);
        });
        phase = DOCKER_LAUNCH_FAILURE_MESSAGES.prompt;
        if (manifest.request.prompt !== null) {
          for (;;) {
            await live();
            await admission?.beforeStart();
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
        if (error instanceof RuntimeGitHubDeliveryError) phase = DOCKER_LAUNCH_FAILURE_MESSAGES.githubDelivery;
        if (workerId && !stopping) {
          // Only the live lease may record a terminal failure. No exception or command output crosses this boundary.
          await sql.query(
            `update public.sandboxes s set status='failed',status_reason=$3
              from public.docker_launch_requests d where s.id=$1 and d.sandbox_id=s.id and d.worker_id=$2
              and d.worker_expires_at>now() and d.result_enc is null and s.status in ('starting','ready','running')
              and s.stop_requested_at is null and s.deleted_at is null
              and not exists(select 1 from public.runtime_commands c where c.sandbox_id=s.id and c.request_id=$4)`,
            [request.requestId, workerId, phase, `docker_prompt_${manifest.promptId}`],
          );
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof ProviderError || error instanceof VaultError) throw error;
      throw failure("unavailable");
    }
  }
  let stopping = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const working = new Set<Promise<void>>();
  async function drain() {
    if (stopping || working.size >= 8) return;
    const work = (async () => {
      const workerId = randomUUID();
      const candidate = (
        await sql.query<{
          sandbox_id: string;
          request_enc: Uint8Array<ArrayBuffer>;
          owner_id: string;
          org_id: string;
          role: GoldenActor["role"];
        }>(
          `
        update public.docker_launch_requests d set worker_id=$1,worker_expires_at=now()+interval '30 seconds'
        where d.sandbox_id=(select q.sandbox_id from public.docker_launch_requests q
          join public.sandboxes s on s.id=q.sandbox_id join public.members m on m.user_id=s.owner_id and m.org_id=s.org_id
          join public.mcp_actor_epochs e on e.user_id=m.user_id and e.org_id=m.org_id and e.epoch=q.actor_epoch
          where q.async_launch and q.result_enc is null and (q.worker_expires_at is null or q.worker_expires_at<=now())
          and s.status in ('starting','ready','running') and s.stop_requested_at is null and s.deleted_at is null and s.expires_at>now()
          order by s.created_at limit 1 for update of q skip locked)
        returning d.sandbox_id,d.request_enc,(select owner_id from public.sandboxes where id=d.sandbox_id) as owner_id,
          (select org_id from public.sandboxes where id=d.sandbox_id) as org_id,
          (select m.role from public.members m join public.sandboxes s on s.owner_id=m.user_id and s.org_id=m.org_id where s.id=d.sandbox_id) as role`,
          [workerId],
        )
      ).rows[0];
      if (!candidate) return;
      const renew = setInterval(() => {
        void sql
          .query(
            `update public.docker_launch_requests set worker_expires_at=now()+interval '30 seconds' where sandbox_id=$1 and worker_id=$2 and worker_expires_at>now()`,
            [candidate.sandbox_id, workerId],
          )
          .catch(() => {});
      }, 10000);
      try {
        const manifest = JSON.parse(await decryptSecret(candidate.request_enc, key)) as Manifest;
        const { image: _image, credentialVersion, prompt, ...body } = manifest.request;
        await launch(
          { userId: candidate.owner_id, orgs: [{ orgId: candidate.org_id, role: candidate.role }], via: "service" },
          {
            ...body,
            ...(credentialVersion === null ? {} : { credentialVersion }),
            ...(prompt === null ? {} : { prompt }),
          },
          undefined,
          workerId,
        );
      } catch {
        // Phase-specific safe reason is durable; never log raw build/authorization errors.
      } finally {
        clearInterval(renew);
        await sql.query(
          `update public.docker_launch_requests set worker_id=null,worker_expires_at=null where sandbox_id=$1 and worker_id=$2`,
          [candidate.sandbox_id, workerId],
        );
      }
    })().finally(() => {
      working.delete(work);
    });
    working.add(work);
    return work;
  }
  return {
    launch: (caller: Caller, body: Record<string, unknown>, admission?: Parameters<typeof launch>[2]) =>
      launch(caller, body, admission),
    drain,
    startBackground() {
      if (timer || !options.deferLaunch) return;
      timer = setInterval(() => {
        void drain().catch(() => {});
      }, 250);
      timer.unref();
    },
    async close() {
      stopping = true;
      if (timer) clearInterval(timer);
      await Promise.allSettled([...working]);
    },
  };
}

export type DockerNormalLaunch = ReturnType<typeof createDockerNormalLaunch>;
