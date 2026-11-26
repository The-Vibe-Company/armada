import { randomUUID } from "node:crypto";
import {
  type AccountSkip,
  type ApplicationSecretBinding,
  DEFAULT_LAUNCH_TTL_SECONDS,
  DOCKER_LAUNCH_FAILURE_MESSAGES,
  type DockerLaunchResult,
  type DockerSandboxRecord,
  dockerSandboxFailureReason,
  type GitHubLaunchInfo,
  type GoldenActor,
  type GoldenRepo,
  type Harness,
  type LaunchCredentialResolver,
  LaunchError,
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
import { dockerHostLaunchFields, dockerSnapshotLaunchFields } from "@armada/core/contract";
import { RUNTIME_STARTUP_FAILURES } from "@armada/core/runtime";
import {
  applyLaunchAccountDefaults,
  createSkillDefaultsService,
  createSqlMcpLaunchPort,
  createSqlMcpRegistry,
  createSqlSandboxStore,
  createTemplateService,
  DockerTemplateAdmissionRefused,
  decryptSecret,
  encryptSecret,
  failureDiagnostic,
  prepareLaunchPlan,
  prepareLaunchWorkspace,
  resolveLaunchConnections,
  resolveLaunchSecrets,
  resolveLaunchSkills,
  resolveLaunchVariables,
  validateLaunchSkillPins,
} from "@armada/core/server";
import { z } from "zod";
import type { Caller } from "./caller.ts";
import { isLaunchConnectionList, UUID } from "./control-input.ts";
import type { createDockerBootstrapService } from "./docker-bootstrap-service.ts";
import { cancelDockerLaunchMailbox, createDockerHostStore } from "./docker-host-store.ts";
import { dockerPoolOpenCodeModel, resolveDockerLaunchAccount } from "./docker-launch-account.ts";
import { createDockerLaunchEnvironment } from "./docker-launch-environment.ts";
import { dockerLaunchRequestHash, matchesDockerLaunchRequestHash } from "./docker-launch-identity.ts";
import { DockerMachinePending } from "./docker-machine-adapter.ts";
import { dockerRepositoryCheckout } from "./docker-repository-checkout.ts";
import { reservationDatabaseDiagnostic, reservationSql } from "./docker-reservation-sql.ts";
import { createDockerRuntimeLifecycle, projectDockerPromptReceipt } from "./docker-runtime-lifecycle.ts";
import { createDockerSandboxService } from "./docker-sandbox-service.ts";
import { resolveDockerSnapshot } from "./docker-snapshot-data.ts";
import { enqueueLaunch } from "./jobs/launch.ts";
import type { Job, JobContext } from "./jobs/runner.ts";
import { createJobsStore, recordDockerLaunchEvidence, withJobLease } from "./jobs/store.ts";
import { admitAccount, preparePoolCandidates } from "./launch-account-pool.ts";
import type { launchCredentials } from "./launch-credentials.ts";
import { recordLaunchStageQuietly } from "./launch-stage-record.ts";
import {
  continueRequest,
  currentRequestId,
  noteAdmission,
  observeProviderCall,
  recordOperatorDiagnostic,
} from "./request-observability.ts";
import { createRuntimeAgent } from "./runtime-agent.ts";
import { createRuntimeCommands, readDockerPromptReceipt } from "./runtime-commands.ts";
import { createRuntimeEnrolments, scopedRuntimeSql } from "./runtime-enrolment.ts";
import { type RuntimeGitHub, RuntimeGitHubConnectionError, RuntimeGitHubDeliveryError } from "./runtime-github.ts";
import type { RuntimeMcp } from "./runtime-mcp.ts";
import { failDockerStartup, recordRuntimeStartupFailure } from "./sandbox-lifecycle.ts";
import { runtimeWakes, waitForTimeout } from "./wake-bus.ts";

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
  credentialId: string | null;
  credentialVersion: number | null;
  requestId: string;
  externalRef?: string;
  model: string;
  reasoningEffort: string;
  ttlSeconds: number;
  prompt: string | null;
  skills?: string[];
  connections?: string[];
  skipSkillDefaults?: boolean;
  stopWhenWorkMerged?: boolean;
};
type Manifest = {
  template?: { id: string; scheduled: boolean };
  accountSkips?: AccountSkip[];
  variables?: Record<string, string>;
  snapshotConfig?: import("@armada/core").GoldenConfig;
  request: Request;
  accountModelDefaulted?: true;
  credentialId?: string;
  credentialVersion: number;
  healthId: string;
  promptId: string;
  conversationId?: string;
  preparation?: { skills: string[]; connections: string[] };
  correlationId?: string;
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
  external_ref: string | null;
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
type Clock = { now(): number; wait(ms: number, signal?: AbortSignal): Promise<void> };
type Options = {
  officialImage?: string;
  github?: Pick<RuntimeGitHub, "prepare" | "prepareLaunch" | "preflightRepositories">;
  credentials: Pick<LaunchCredentialResolver, "resolve" | "skillpackKey" | "authorizeRepositories" | "defaults"> &
    Pick<ReturnType<typeof launchCredentials>, "launchAccountDefault">;
  mcp?: RuntimeMcp;
  bootstrap?: ReturnType<typeof createDockerBootstrapService>;
  clock?: Clock;
  timeoutMs?: number;
};
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
    ...(code === "unavailable" ? { details: { resourceReceipt: true } } : {}),
  });
}
function warnLaunchFailure(error: unknown, reason: string, dispatchPossible: boolean) {
  const requestId = currentRequestId();
  console.warn("docker_launch_failed", {
    ...(requestId ? { requestId } : {}),
    reason,
    ...(reason === "reservation"
      ? { statement: "reservation_transaction", ...reservationDatabaseDiagnostic(error) }
      : {}),
    dispatchPossible,
    code:
      error instanceof ProviderError || error instanceof VaultError || error instanceof LaunchError
        ? error.code
        : "dependency_unavailable",
  });
}
function identifier(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value)) throw failure("invalid_request");
  return value.toLowerCase();
}
const reservationId = z.string().regex(UUID);
const dockerAdmissionInput = z.union([
  dockerHostLaunchFields.extend({ requestId: reservationId }),
  dockerSnapshotLaunchFields.extend({ requestId: reservationId }),
]);
type DockerAdmissionInput = z.infer<typeof dockerAdmissionInput>;

function normalize(body: DockerAdmissionInput, org: string, hostId: string, image: string) {
  const ttlSeconds = body.ttlSeconds ?? DEFAULT_LAUNCH_TTL_SECONDS;
  if (body.skills !== undefined) {
    try {
      validateLaunchSkillPins(body.skills);
    } catch {
      throw failure("invalid_request");
    }
  }
  let choice: ReturnType<typeof resolveModelChoice>;
  try {
    choice = resolveModelChoice(body.harness, {
      model: body.model,
      reasoningEffort: body.reasoningEffort,
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
  if ("repos" in body && body.repos !== undefined) {
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
    ...("snapshotId" in body ? { snapshotId: identifier(body.snapshotId) } : {}),
    org,
    provider: "docker",
    harness: body.harness,
    visibility: "private",
    hostId,
    image,
    credentialId: body.credentialId === undefined ? null : identifier(body.credentialId),
    credentialVersion: body.credentialVersion ?? null,
    requestId: identifier(body.requestId),
    ...(body.externalRef === undefined ? {} : { externalRef: body.externalRef }),
    model: choice.model,
    reasoningEffort: choice.reasoningEffort,
    ttlSeconds,
    prompt: body.prompt ?? null,
    ...(body.skills === undefined ? {} : { skills: [...body.skills] }),
    ...(body.stopWhenWorkMerged === false ? { stopWhenWorkMerged: false } : {}),
    ...(body.skipSkillDefaults === undefined ? {} : { skipSkillDefaults: body.skipSkillDefaults }),
    ...(body.connections === undefined
      ? {}
      : { connections: [...new Set(body.connections.map((id) => id.toLowerCase()))].sort() }),
  } satisfies Request;
}
const repositoryAccessMessage = (message: string | null | undefined): message is string =>
  typeof message === "string" &&
  (/^Repository [A-Za-z0-9][A-Za-z0-9_.-]{0,80} needs a GitHub connection with read access\. Run armada account login github, grant your account and the Armada GitHub App access, then launch again\.$/.test(
    message,
  ) ||
    /^Repository [A-Za-z0-9][A-Za-z0-9_.-]{0,80} could not be verified as public before launch\. Run armada account login github or retry when GitHub is available\.$/.test(
      message,
    ));
function storedRepositoryAccessMessage(reason: string | null) {
  const message = reason?.replace("Run armada github connect", "Run armada account login github");
  return repositoryAccessMessage(message) ? message : undefined;
}

const notReady = (row: Row) => {
  const message = row.status === "failed" ? storedRepositoryAccessMessage(row.status_reason) : undefined;
  return message
    ? new LaunchError("no_credentials", message)
    : failure("sandbox_not_ready", dockerSandboxFailureReason(row.status_reason));
};
const dockerJobKey = (sandboxId: string) => JSON.stringify(["docker", sandboxId]);
const iso = (date: Date | string) => new Date(date).toISOString();
const active = (row: Row) =>
  ["starting", "ready", "running"].includes(row.status) &&
  row.stop_requested_at === null &&
  row.deleted_at === null &&
  !row.expired;

export function createDockerLaunchPlacement(sql: Sql, key: string, options: Options) {
  const clock = options.clock ?? {
    now: Date.now,
    wait: (ms: number, signal?: AbortSignal) =>
      signal ? waitForTimeout(ms, signal) : new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const runtime = createDockerRuntimeLifecycle(sql, key);
  const templates = createTemplateService(sql, key);
  async function transaction<T>(work: (tx: Sql) => Promise<T>) {
    if (!sql.transaction) throw failure("unavailable");
    return sql.transaction(work);
  }
  async function member(tx: Sql, actor: { userId: string; orgId: string }) {
    const membership = (
      await tx.query<{ role: GoldenActor["role"]; epoch: string }>(
        `select m.role,e.epoch::text from public.members m join public.mcp_actor_epochs e on e.org_id=m.org_id and e.user_id=m.user_id
       where m.org_id=$1 and m.user_id=$2 for share of m`,
        [actor.orgId, actor.userId],
      )
    ).rows[0];
    if (!membership) throw failure("not_found");
    return membership;
  }
  async function load(
    tx: Sql,
    actor: { userId: string; orgId: string },
    request: Request,
    hash: string,
    explicitModel = false,
  ) {
    const membership = await member(tx, actor);
    const row = (
      await tx.query<Row>(
        `select id,org_id,owner_id,provider,harness,provider_sandbox_id,docker_host_id,docker_image,docker_snapshot_id,status,status_reason,
        conversation_ids,created_at,stopped_at,deleted_at,stop_requested_at,expires_at,effective_ttl_seconds,
        lifecycle_generation,requested_ttl_seconds,credential_id,credential_version,model,reasoning_effort,skills,external_ref,
        expires_at<=now() as expired from public.sandboxes where id=$1`,
        [request.requestId],
      )
    ).rows[0];
    if (!row) return { membership };
    if (row.owner_id !== actor.userId || row.org_id !== actor.orgId || row.provider !== "docker")
      throw failure("not_found");
    const claim = (
      await tx.query<Claim>(
        `select actor_epoch::text,request_hash,request_enc,result_enc from public.docker_launch_manifests where sandbox_id=$1`,
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
      (explicitModel && manifest.accountModelDefaulted) ||
      (manifest.credentialId !== undefined && !UUID.test(manifest.credentialId)) ||
      (!claim.result_enc &&
        active(row) &&
        (row.credential_version !== manifest.credentialVersion ||
          row.credential_id !== (manifest.credentialId ?? manifest.request.credentialId))) ||
      (manifest.conversationId !== undefined &&
        (typeof manifest.conversationId !== "string" || !UUID.test(manifest.conversationId))) ||
      !Number.isSafeInteger(manifest.credentialVersion) ||
      manifest.credentialVersion < 1 ||
      ![manifest.healthId, manifest.promptId].every((id) => typeof id === "string" && UUID.test(id))
    )
      throw failure("conflict");
    if (manifest.preparation !== undefined) {
      try {
        validateSkillPins(manifest.preparation.skills);
      } catch {
        throw failure("conflict");
      }
      if (!isLaunchConnectionList(manifest.preparation.connections)) throw failure("conflict");
    } else if (manifest.request.skills !== undefined || manifest.request.connections !== undefined)
      throw failure("conflict");
    if (
      claim.result_enc &&
      (!receipt ||
        typeof receipt.epoch !== "string" ||
        !/^[1-9][0-9]{0,18}$/.test(receipt.epoch) ||
        (receipt.promptId !== undefined && (typeof receipt.promptId !== "string" || !UUID.test(receipt.promptId))) ||
        (receipt.conversationId !== undefined &&
          (typeof receipt.conversationId !== "string" || !UUID.test(receipt.conversationId))) ||
        (receipt.promptId === undefined) !== (receipt.conversationId === undefined))
    )
      throw failure("conflict");
    return { membership, row, manifest, receipt };
  }
  function envelope(row: Row, receipt?: Receipt) {
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
        row.status === "failed"
          ? (storedRepositoryAccessMessage(row.status_reason) ?? dockerSandboxFailureReason(row.status_reason))
          : null,
      repositoryDir: null,
      model: row.model,
      reasoningEffort: row.reasoning_effort,
      credentialId: row.credential_id,
      credentialVersion: row.credential_version,
      expiresAt: iso(row.expires_at),
      effectiveTtlSeconds: row.effective_ttl_seconds,
      requestedTtlSeconds: row.requested_ttl_seconds,
      skills: row.skills ?? [],
      ...(row.external_ref ? { externalRef: row.external_ref } : {}),
    };
    return {
      sandbox,
      golden: null,
      helper: null,
      github: receipt?.github ?? {
        status: "unavailable",
        message: receipt
          ? "GitHub access requires repositories in the Docker launch or snapshot configuration."
          : "GitHub preparation has not completed for this launch.",
      },
      runtime: receipt ? { kind: "armada", epoch: receipt.epoch } : null,
      ttlSeconds: row.effective_ttl_seconds,
      expiresAt: iso(row.expires_at),
      ...(receipt?.promptId ? { promptId: receipt.promptId } : {}),
      ...(receipt?.conversationId ? { conversationId: receipt.conversationId } : {}),
    } satisfies DockerLaunchResult;
  }
  async function reserve(
    caller: Caller,
    body: Record<string, unknown>,
    admission?: {
      beforeReserve(tx: Sql): Promise<void>;
      id: string;
      scheduled: boolean;
    },
  ) {
    let dispatchPossible = false;
    let reason = "request_validation";
    let diagnosticSandboxId: string | undefined;
    const validate = () => {
      const parsed = dockerAdmissionInput.safeParse(body);
      if (!parsed.success)
        throw failure(
          "invalid_request",
          body && Object.hasOwn(body, "image")
            ? "Remove the image field and retry. Armada chooses the Docker environment automatically."
            : undefined,
        );
      const request = parsed.data;
      const snapshotId = "snapshotId" in request ? identifier(request.snapshotId) : undefined;
      const org = identifier(request.org);
      const member = caller.orgs.find((entry) => entry.orgId === org);
      if (!member) throw failure("not_found");
      return { request, snapshotId, org, role: member.role };
    };
    const resolve = async ({ request: input, snapshotId, org, role }: ReturnType<typeof validate>) => {
      reason = "launch_receipt_lookup";
      dispatchPossible = true;
      const retained = (
        await sql.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
          `select d.request_enc from public.docker_launch_manifests d join public.sandboxes s on s.id=d.sandbox_id
           join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
           join public.mcp_actor_epochs e on e.org_id=s.org_id and e.user_id=s.owner_id and e.epoch=d.actor_epoch
           where s.id=$1 and s.owner_id=$2 and s.org_id=$3 and s.provider='docker' and ($4::uuid is null or s.docker_snapshot_id=$4)`,
          [identifier(input.requestId), caller.userId, org, snapshotId ?? null],
        )
      ).rows[0];
      dispatchPossible = Boolean(retained);
      const frozen = retained
        ? (JSON.parse(await decryptSecret(retained.request_enc, key)) as Manifest).request
        : undefined;
      const source =
        snapshotId && !frozen
          ? await resolveDockerSnapshot(sql, { userId: caller.userId, orgId: org }, snapshotId)
          : undefined;
      const sourceHost = snapshotId ? (frozen?.hostId ?? source?.host_id) : undefined,
        sourceImage = frozen?.image ?? source?.image_id;
      if (sourceHost && input.hostId !== undefined && identifier(input.hostId) !== sourceHost)
        throw failure("not_found");
      reason = "official_image";
      let image: string;
      try {
        image = sourceImage ?? options.officialImage ?? officialSandboxImage();
      } catch {
        throw new ProviderError({
          provider: "docker",
          code: "provider_routing_unavailable",
          retryable: false,
          message:
            "Armada's sandbox image configuration is invalid. Ask the server operator to deploy a matching release image pin. No sandbox was created.",
        });
      }
      reason = "account_defaults";
      const accountActor = { userId: caller.userId, orgId: org, role };
      const accountDefault =
        frozen || input.credentialId !== undefined
          ? undefined
          : await options.credentials.launchAccountDefault?.(accountActor.userId, input.harness);
      const preference = frozen
        ? { credentialId: frozen.credentialId ?? null, model: frozen.model }
        : accountDefault
          ? {
              credentialId: accountDefault.credentialIds.length ? null : accountDefault.credentialId,
              model: accountDefault.model,
            }
          : await options.credentials.defaults?.(accountActor, input.harness);
      const selected = applyLaunchAccountDefaults(input, preference);
      const request = normalize(selected, org, sourceHost ?? identifier(input.hostId), image);
      const actor = { userId: identifier(caller.userId), orgId: request.org };
      if (!caller.orgs.some((org) => org.orgId.toLowerCase() === request.org)) throw failure("not_found");
      const hash = dockerLaunchRequestHash(request);
      reason = "membership_and_launch_state";
      const explicitModel = input.model !== undefined;
      const state = await transaction((tx) => load(tx, actor, request, hash, explicitModel));
      dispatchPossible ||= Boolean(state.row);
      const plan = { request, actor, hash, state, explicitModel };
      if (state.receipt) return { ...plan, fresh: null };
      reason = "runtime_configuration";
      if (!options.bootstrap) throw failure("unavailable");
      if (state.manifest) return { ...plan, fresh: null };
      const snapshotRepositories = source?.config.repos;
      reason = "credential_resolution";
      const launchActor = { ...actor, role: state.membership.role };
      const pool =
        request.credentialId === null && request.credentialVersion === null && accountDefault?.credentialIds.length
          ? { harness: request.harness, credentialIds: accountDefault.credentialIds, model: request.model }
          : undefined;
      const accounts = pool
        ? await preparePoolCandidates(sql, actor.userId, pool, async (credentialId, model) => {
            const entry = await resolveDockerLaunchAccount(
              options.credentials,
              launchActor,
              { ...request, credentialId },
              { ...selected, model },
            );
            const choice = entry.modelChoice ?? resolveModelChoice(request.harness, { ...selected, model });
            const compatibleModel =
              request.harness === "opencode" ? dockerPoolOpenCodeModel(entry.resolved.env, choice.model) : choice.model;
            if (!compatibleModel) return;
            return {
              ...entry.binding,
              ...choice,
              model: compatibleModel,
              resolved: entry.resolved,
            };
          })
        : undefined;
      const initial = accounts?.values().next().value;
      const { resolved, binding, modelChoice } = initial
        ? { resolved: initial.resolved, binding: initial, modelChoice: initial }
        : await resolveDockerLaunchAccount(options.credentials, launchActor, request, selected);
      if (snapshotRepositories?.length)
        await options.credentials.authorizeRepositories?.(launchActor, resolved, snapshotRepositories);
      reason = "skill_defaults";
      const skills = await resolveLaunchSkills(
        request,
        () => createSkillDefaultsService(sql).resolve(launchActor, null),
        () => failure("invalid_request"),
      );
      reason = "mcp_defaults";
      const connections = await resolveLaunchConnections(
        request.connections,
        () => createSqlMcpLaunchPort(sql, createSqlMcpRegistry(sql, key)).defaults(actor, "private"),
        async (ids) => {
          if (!ids.length) return;
          if (!options.mcp) throw failure("unavailable");
          await options.mcp.connections.validate(actor, ids, "private");
        },
      );
      const correlationId = currentRequestId();
      const manifest: Manifest = {
        ...(admission ? { template: { id: admission.id, scheduled: admission.scheduled } } : {}),
        ...(source ? { snapshotConfig: source.config } : {}),
        request,
        ...(!pool && selected.model === undefined && modelChoice && modelChoice.model !== request.model
          ? { accountModelDefaulted: true }
          : {}),
        credentialId: binding.credentialId,
        credentialVersion: binding.credentialVersion,
        healthId: randomUUID(),
        promptId: randomUUID(),
        conversationId: randomUUID(),
        preparation: { skills, connections },
        ...(correlationId ? { correlationId } : {}),
      };
      return {
        ...plan,
        fresh: { resolved, binding, manifest, modelChoice, pool, accounts },
      };
    };

    const dockerPlacement = {
      async admit(plan: Awaited<ReturnType<typeof resolve>>, launchAdmission: typeof admission) {
        const { actor, request, hash, state, explicitModel } = plan;
        if (!plan.fresh) return state;
        let { resolved } = plan.fresh;
        const { binding, manifest, modelChoice, pool, accounts } = plan.fresh;
        const choice = modelChoice ?? request;
        reason = "reservation";
        return transaction(async (connection) => {
          const tx = reservationSql(connection);
          // WARNING: Changing this lock key breaks reservation serialization during a rolling deploy.
          await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [
            `docker-normal-launch:${request.requestId}`,
          ]);
          // WARNING: A member SHARE lock here would invert the reserve lock order.
          const exists =
            (await tx.query(`select id from public.sandboxes where id=$1`, [request.requestId])).rows.length > 0;
          if (exists) {
            dispatchPossible = true;
            return load(tx, actor, request, hash, explicitModel);
          }
          await createDockerSandboxService(scopedRuntimeSql(tx)).reserve(
            actor,
            {
              requestId: request.requestId,
              hostId: request.hostId,
              image: request.image,
              harness: request.harness,
              credentialId: binding.credentialId,
              credentialVersion: manifest.credentialVersion,
              ...(request.externalRef === undefined ? {} : { externalRef: request.externalRef }),
              model: choice.model,
              reasoningEffort: choice.reasoningEffort,
              ...(request.stopWhenWorkMerged === undefined ? {} : { stopWhenWorkMerged: request.stopWhenWorkMerged }),
              ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: request.ttlSeconds }),
            },
            launchAdmission?.beforeReserve,
            request.snapshotId,
            pool && accounts
              ? async (accountTx) => {
                  const selected = await admitAccount(accountTx, actor.userId, pool, request.requestId, accounts);
                  const { resolved: selectedCredentials, ...candidate } = selected.candidate;
                  resolved = selectedCredentials;
                  manifest.credentialId = candidate.credentialId;
                  manifest.credentialVersion = candidate.credentialVersion;
                  if (selected.skips.length) manifest.accountSkips = selected.skips;
                  return candidate;
                }
              : undefined,
          );
          if (resolved.usagePricing)
            await createSqlSandboxStore(scopedRuntimeSql(tx), { turnModels: true }).recordUsagePricingContext?.(
              request.requestId,
              resolved.usagePricing,
            );
          try {
            if (request.variables?.length)
              manifest.variables = await resolveLaunchVariables(scopedRuntimeSql(tx), actor, request.variables);
            if (request.secrets?.length)
              validateReadableVariables({
                ...manifest.variables,
                ...(await resolveLaunchSecrets(scopedRuntimeSql(tx), actor, request.secrets, key)),
              });
          } catch {
            throw failure("unavailable");
          }
          const connections = manifest.preparation?.connections ?? [];
          const port = createSqlMcpLaunchPort(scopedRuntimeSql(tx), createSqlMcpRegistry(scopedRuntimeSql(tx), key));
          await port.validate(actor, connections, "private");
          await port.bind(request.requestId, connections);
          const current = await member(tx, actor);
          const receiptKey = dockerJobKey(request.requestId);
          const { id } = await enqueueLaunch(
            createJobsStore(sql, key),
            request.requestId,
            1,
            receiptKey,
            manifest,
            {
              orgId: actor.orgId,
              request: { ownerId: actor.userId, digest: hash },
              deadline: new Date(Date.now() + (options.timeoutMs ?? 600_000)),
              maxAttempts: 8,
            },
            tx,
          );
          await recordDockerLaunchEvidence(tx, id, { docker_actor_epoch: current.epoch });
          noteAdmission();
          const reserved = await load(tx, actor, request, hash);
          dispatchPossible = true;
          return reserved;
        });
      },
    };

    try {
      const launchPlan = await prepareLaunchPlan(validate, resolve, () => dockerPlacement);
      const state = await launchPlan.admit(admission);
      diagnosticSandboxId = state.row?.id;
      if (!state.row || !state.manifest) throw failure("unavailable");
      return envelope(state.row, state.receipt);
    } catch (error) {
      recordOperatorDiagnostic(`docker.launch.${reason}`, failureDiagnostic(error), {
        sandboxId: diagnosticSandboxId,
      });
      warnLaunchFailure(error, reason, dispatchPossible);
      if (!dispatchPossible) {
        if (admission) {
          const publicError = error instanceof ProviderError || error instanceof VaultError;
          throw new DockerTemplateAdmissionRefused(
            publicError ? error.code : "launch_unavailable",
            publicError ? error.message : "Docker template launch failed before dispatch.",
            { cause: error },
          );
        }
        if (error instanceof ProviderError) {
          const { resourceReceipt: _receipt, keepSource: _source, ...details } = error.details ?? {};
          throw new ProviderError({
            provider: "docker",
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            details,
          });
        }
        if (error instanceof VaultError || error instanceof LaunchError) throw error;
        throw new VaultError(
          "unavailable",
          `Docker launch failed before dispatch (${reason}). Ask the server operator to check this prerequisite; no host work was queued by this attempt.`,
        );
      }
      if (error instanceof ProviderError || error instanceof VaultError || error instanceof LaunchError) throw error;
      throw failure("unavailable");
    }
  }
  async function reconcile(caller: Caller, jobRequest: Request, worker: { job: Job; context: JobContext }) {
    let reason = "membership_and_launch_state";
    let readinessCause = "readiness_check_failed";
    try {
      const actor = { userId: caller.userId, orgId: jobRequest.org };
      const hash = dockerLaunchRequestHash(jobRequest);
      const state = await transaction((tx) => load(tx, actor, jobRequest, hash));
      if (!state.row || !state.manifest) throw failure("unavailable");
      if (state.receipt) return envelope(state.row, state.receipt);
      reason = "runtime_configuration";
      if (!options.bootstrap) throw failure("unavailable");
      const { manifest } = state;
      const { request } = manifest;
      const defaults = { model: state.row.model, reasoningEffort: state.row.reasoning_effort };
      let phase: string = DOCKER_LAUNCH_FAILURE_MESSAGES.startup;
      let templateLockContended = false;
      const assertTemplate = async (tx: Sql, references = false) => {
        if (!manifest.template) return;
        await templates
          .revalidateDockerLaunch(tx, actor, request.requestId, manifest.template, references)
          .catch((error) => {
            templateLockContended ||= reservationDatabaseDiagnostic(error).sqlstate === "55P03";
            throw error;
          });
      };
      const watches: ReturnType<typeof runtimeWakes.watch>[] = [];
      const watch = (wakeKey: string) => {
        const handle = runtimeWakes.watch(wakeKey);
        watches.push(handle);
        return handle;
      };
      try {
        if (request.repos?.length || manifest.snapshotConfig?.repos.length) {
          const createDispatched =
            (
              await sql.query(
                `select 1 from public.docker_host_jobs where bound_sandbox_id=$1 and bound_operation='create'
                 union all
                 select 1 from public.runtime_enrolments where sandbox_id=$1 and runtime_hash is not null
                 limit 1`,
                [request.requestId],
              )
            ).rows.length > 0;
          if (!createDispatched) {
            reason = "github_preparation";
            phase = DOCKER_LAUNCH_FAILURE_MESSAGES.github;
            const repositories = request.repos ?? manifest.snapshotConfig!.repos;
            await options.credentials.authorizeRepositories?.(
              { ...actor, role: state.membership.role },
              {},
              repositories,
            );
            if (request.repos) {
              if (!options.github) throw failure("unavailable");
              await options.github.preflightRepositories(caller, request.org, repositories);
            }
          }
        }
        phase = DOCKER_LAUNCH_FAILURE_MESSAGES.startup;
        reason = "machine_start";
        const assertClaim = async (tx: Sql) => {
          const { docker_actor_epoch: admittedEpoch } = worker.job.outcome as { docker_actor_epoch: string };
          if ((await member(tx, actor)).epoch !== admittedEpoch || !(await worker.context.canDispatch(tx)))
            throw failure("unavailable");
          await assertTemplate(tx);
        };
        if (manifest.template) await transaction((tx) => assertTemplate(tx, true));
        const deadline = clock.now() + (options.timeoutMs ?? 600_000);
        const live = async () => {
          if (!(await worker.context.canDispatch())) throw failure("unavailable");
          const current = await transaction((tx) => load(tx, actor, request, hash));
          if (!current.row) throw failure("not_found");
          if (!active(current.row)) {
            if (reason === "runtime_readiness") {
              const { status, status_reason: statusReason } = current.row;
              readinessCause =
                Object.entries(RUNTIME_STARTUP_FAILURES).find(([, message]) => message === statusReason)?.[0] ??
                (status === "failed" ? "startup_failed" : "sandbox_inactive");
            }
            throw notReady(current.row);
          }
          return current;
        };
        async function wait(ms = 250, signal?: AbortSignal) {
          if (clock.now() >= deadline) {
            if (reason === "runtime_readiness") readinessCause = "readiness_deadline";
            throw failure("unavailable");
          }
          await clock.wait(Math.min(ms, deadline - clock.now()), signal ?? worker.context.signal);
        }
        async function waitFor(handle: ReturnType<typeof runtimeWakes.watch>) {
          if (clock.now() >= deadline) {
            if (reason === "runtime_readiness") readinessCause = "readiness_deadline";
            throw failure("unavailable");
          }
          await handle.wait(worker.context.signal, Math.min(250, deadline - clock.now()), (ms, signal) =>
            clock.wait(ms, signal),
          );
          worker.context.signal.throwIfAborted();
        }
        await startMachine(actor, request, state.row, worker, assertClaim);
        reason = "runtime_readiness";
        let receipt: Receipt;
        const readinessWatch = watch(`socket:${request.requestId}`);
        for (;;) {
          await live();
          const ready = await runtime
            .ready(actor, request.requestId, manifest.healthId, worker.job.generation ?? undefined, assertClaim)
            .catch(async (error) => {
              await live().catch(() => {});
              throw error;
            });
          if (ready.state === "ready") {
            receipt = { epoch: ready.epoch };
            break;
          }
          await waitFor(readinessWatch);
        }
        reason = "runtime_environment";
        phase = DOCKER_LAUNCH_FAILURE_MESSAGES.environment;
        await createDockerLaunchEnvironment(sql, key, clock)(caller, request.requestId, assertClaim);
        reason = "github_preparation";
        phase = DOCKER_LAUNCH_FAILURE_MESSAGES.github;
        if (!manifest.request.repos && manifest.snapshotConfig?.repos.length) {
          receipt.github = options.github
            ? await options.github.prepareLaunch(caller, request.requestId, assertClaim)
            : {
                status: "not_connected",
                message: "GitHub is not connected; public snapshot repositories refresh anonymously.",
              };
          reason = "repository_checkout";
          phase = DOCKER_LAUNCH_FAILURE_MESSAGES.checkout;
          const agent = createRuntimeAgent(
            createRuntimeCommands(createRuntimeEnrolments(sql, key), key, {
              now: clock.now,
              wait: async (ms, signal) => {
                await live();
                await wait(ms, signal);
              },
            }),
            {
              provider: "docker",
              harness: request.harness,
              ownerId: actor.userId,
              sandboxId: request.requestId,
              providerSandboxId: request.requestId,
              cwd: "/home/user",
              defaults,
            },
          );
          const warnings = await prepareLaunchWorkspace(
            {
              id: "docker",
              exec: async () => {
                throw Error("Snapshot refresh requires enrolled workspace execution.");
              },
            },
            request.requestId,
            request.requestId,
            { config: { repos: manifest.snapshotConfig.repos, init: [] } },
            [],
            () => {},
            async (ms) => {
              await live();
              await clock.wait(ms, worker.context.signal);
            },
            async (command, step) => {
              await live();
              return agent.workspaceExec(command, step, receipt.epoch, worker.context.signal, assertClaim);
            },
            receipt.github?.status === "connected",
          );
          if (warnings.length)
            receipt.github = {
              ...receipt.github,
              message: [receipt.github.message, ...warnings].filter(Boolean).join(" "),
            };
          await recordLaunchStageQuietly(sql, request.requestId, "checkout_done");
        }
        if (manifest.request.repos) {
          if (!options.github) throw failure("unavailable");
          const github = await options.github.prepare(caller, request.requestId, undefined, assertClaim);
          receipt.github = { status: "connected", login: github.login };
          reason = "repository_checkout";
          phase = DOCKER_LAUNCH_FAILURE_MESSAGES.checkout;
          const command = dockerRepositoryCheckout(manifest.request.repos, "/home/user");
          const commands = createRuntimeCommands(createRuntimeEnrolments(sql, key), key);
          const id = `docker_checkout_${request.requestId}`;
          const checkoutWatch = watch(`reply:${request.requestId}:${receipt.epoch}:${id}`);
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
            assertClaim,
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
            await waitFor(checkoutWatch);
          }
          await recordLaunchStageQuietly(sql, request.requestId, "checkout_done");
        }
        reason = "skills";
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
              wait: (ms, signal) => clock.wait(ms, signal),
            }),
            {
              provider: "docker",
              harness: request.harness,
              ownerId: actor.userId,
              sandboxId: request.requestId,
              providerSandboxId: request.requestId,
              cwd: "/home/user",
              defaults,
            },
          );
          const receipts = await agent.installSkills(
            selections.skills,
            skillKey,
            receipt.epoch,
            worker.context.signal,
            undefined,
            assertClaim,
          );
          await createRuntimeEnrolments(sql, key).withOwner(request.requestId, actor.userId, async (tx, scope) => {
            if (scope.epoch !== receipt.epoch) throw failure("sandbox_not_ready");
            await assertClaim?.(tx);
            await createSqlSandboxStore(scopedRuntimeSql(tx)).recordSkills!(request.requestId, receipts);
          });
        }
        reason = "mcp_preparation";
        if (options.mcp) await options.mcp.prepare(caller, request.requestId, worker.context.signal, assertClaim);
        else if (selections?.connections.length) throw failure("unavailable");
        reason = "runtime_epoch_validation";
        await live();
        await createRuntimeEnrolments(sql, key).withOwner(request.requestId, actor.userId, async (_tx, scope) => {
          if (scope.epoch !== receipt.epoch) throw failure("sandbox_not_ready");
        });
        reason = "first_prompt";
        phase = DOCKER_LAUNCH_FAILURE_MESSAGES.prompt;
        if (manifest.request.prompt !== null) {
          if (manifest.template) await transaction((tx) => assertTemplate(tx, true));
          const prior = (
            await sql.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
              "select request_enc from public.runtime_commands where sandbox_id=$1 and request_id=$2",
              [request.requestId, `docker_prompt_${manifest.promptId}`],
            )
          ).rows[0];
          const conversationId = prior
            ? (JSON.parse(await decryptSecret(prior.request_enc, key)).input.conversationId as string | undefined)
            : (manifest.conversationId ?? manifest.promptId);
          const promptWatch = watch(`reply:${request.requestId}:${receipt.epoch}:docker_prompt_${manifest.promptId}`);
          for (;;) {
            await live();
            const result = await runtime.prompt(
              actor,
              request.requestId,
              {
                requestId: manifest.promptId,
                text: manifest.request.prompt,
                ...(conversationId === undefined ? {} : { conversationId }),
              },
              receipt.epoch,
              assertClaim,
            );
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
            await waitFor(promptWatch);
          }
        }
        reason = "receipt_publication";
        const encrypted = await encryptSecret(JSON.stringify(receipt), key);
        return await transaction(async (tx) => {
          const authority = createRuntimeEnrolments(scopedRuntimeSql(tx), key);
          // WARNING: Lock source actors before taking the host, sandbox or runtime locks.
          await authority.lockSourceMembers(tx, request.requestId, actor.userId);
          const current = await load(tx, actor, request, hash);
          if (!current.row) throw failure("not_found");
          if (current.receipt) return envelope(current.row, current.receipt);
          if (!active(current.row)) throw failure("sandbox_not_ready");
          await authority.withOwner(request.requestId, actor.userId, async (_tx, scope) => {
            if (scope.epoch !== receipt.epoch) throw failure("sandbox_not_ready");
            await assertClaim(tx);
            await recordDockerLaunchEvidence(tx, worker.job.id, {
              docker_receipt: Buffer.from(encrypted).toString("hex"),
            });
            if (manifest.template)
              await templates.completeDockerLaunch(tx, manifest.template.id, request.requestId, receipt);
          });
          const saved = await load(tx, actor, request, hash);
          if (!saved.row || !saved.receipt) throw failure("unavailable");
          return envelope(saved.row, saved.receipt);
        });
      } catch (error) {
        if (templateLockContended) throw new DockerMachinePending("pending");
        if (error instanceof RuntimeGitHubConnectionError) phase = DOCKER_LAUNCH_FAILURE_MESSAGES.githubNotConnected;
        else if (error instanceof RuntimeGitHubDeliveryError) phase = DOCKER_LAUNCH_FAILURE_MESSAGES.githubDelivery;
        else if (
          error instanceof LaunchError &&
          error.code === "no_credentials" &&
          repositoryAccessMessage(error.message)
        )
          phase = error.message;
        if (!(error instanceof DockerMachinePending) && !worker.context.signal.aborted) {
          await withJobLease(sql, worker.job, async (tx) => {
            if (!(await worker.context.canDispatch(tx))) return;
            const prior = await tx.query(
              "select 1 from public.runtime_commands where sandbox_id=$1 and request_id=$2",
              [request.requestId, `docker_prompt_${manifest.promptId}`],
            );
            if (!prior.rows.length)
              await recordRuntimeStartupFailure(
                tx,
                request.requestId,
                String(state.row.lifecycle_generation),
                "docker_launch_failed",
                phase,
              );
          });
        }
        throw error;
      } finally {
        for (const handle of watches) handle.close();
      }
    } catch (error) {
      if (!(error instanceof DockerMachinePending)) {
        warnLaunchFailure(error, reason, true);
        recordOperatorDiagnostic(`docker.launch.${reason}`, failureDiagnostic(error), {
          sandboxId: jobRequest.requestId,
          causeCode: reason === "runtime_readiness" ? readinessCause : undefined,
        });
      }
      throw error;
    }
  }

  const launched = (result: DockerLaunchResult) => result.sandbox.status !== "failed";

  async function startMachine(
    actor: { userId: string; orgId: string },
    request: Request,
    row: Row,
    { job, context }: { job: Job; context: JobContext },
    assertClaim: (tx: Sql) => Promise<void>,
  ) {
    const { requestId: sandboxId, hostId, image, snapshotId } = request;
    const generation = Number(job.generation);
    const target = await sql.query<{ docker_installation_id: string; enrolled: boolean }>(
      `
      select s.docker_installation_id,
        exists(select 1 from public.runtime_enrolments e where e.sandbox_id=s.id
          and e.lifecycle_generation=s.lifecycle_generation and e.runtime_hash is not null) as enrolled
      from public.sandboxes s join public.jobs j on j.id=$2 and j.sandbox_id=s.id and j.generation=s.lifecycle_generation
      where s.id=$1 and s.lifecycle_generation=$3 and s.stop_requested_at is null`,
      [sandboxId, job.id, generation],
    );
    const placement = target.rows[0];
    if (!placement || !(await context.canDispatch())) throw failure("unavailable");
    if (placement.enrolled) return;
    const source = snapshotId ? { kind: "snapshot" as const, ref: snapshotId } : { kind: "image" as const, ref: image };
    const scope = { actor, hostId, installationId: placement.docker_installation_id };
    const canDispatch: JobContext["canDispatch"] = async (tx) => {
      if (!tx) return context.canDispatch();
      await assertClaim(tx);
      return true;
    };
    const machine = createDockerHostStore(sql, key).machine({ ...scope, canDispatch });
    const incarnation = { sandboxId, generation, signal: context.signal };
    const observed = await machine.observe(incarnation);
    const targetMachine =
      observed.kind === "present"
        ? observed.machine
        : await machine.create({
            ...incarnation,
            source,
            size: null,
            computeTtlSeconds: row.effective_ttl_seconds,
          });
    await options.bootstrap!.bootstrapMachine(actor, targetMachine, { ...context, canDispatch });
    throw new DockerMachinePending("pending");
  }

  async function run(job: Job, context: JobContext) {
    const manifest = job.payload as Manifest;
    const { request } = manifest;
    const membership = await sql.query<{ role: GoldenActor["role"]; user_id: string }>(
      `select m.role,m.user_id from public.jobs j join public.sandboxes s on s.id=j.sandbox_id and s.lifecycle_generation=j.generation
       join public.members m on m.org_id=j.org_id and m.user_id=j.request_owner_id
       join public.mcp_actor_epochs e on e.org_id=m.org_id and e.user_id=m.user_id
       where j.id=$1 and e.epoch::text=j.outcome->>'docker_actor_epoch' and s.stop_requested_at is null`,
      [job.id],
    );
    const role = membership.rows[0]?.role;
    const settleInactive = async () => {
      if ((job.outcome as { docker_receipt?: string }).docker_receipt) return { status: "done" as const };
      const generation = job.generation;
      if (!context.signal.aborted && generation) {
        const reconciled = await withJobLease(
          sql,
          job,
          async (tx) => {
            const commandId = `docker_prompt_${manifest.promptId}`;
            const prior = (
              await tx.query<{
                epoch: string;
                result_enc: Uint8Array<ArrayBuffer> | null;
                request_enc: Uint8Array<ArrayBuffer>;
                owner_id: string;
                model: string;
                conversation_ids: string[];
              }>(
                `select c.epoch::text,c.result_enc,c.request_enc,s.owner_id,s.model,s.conversation_ids
               from public.runtime_commands c join public.runtime_enrolments e
                 on e.sandbox_id=c.sandbox_id and e.epoch=c.epoch and e.lifecycle_generation=$3
               join public.sandboxes s on s.id=c.sandbox_id
               where c.sandbox_id=$1 and c.request_id=$2 and e.runtime_hash is not null
                 and s.status in ('ready','running') and s.stop_requested_at is null and s.expires_at>clock_timestamp()`,
                [request.requestId, commandId, generation],
              )
            ).rows[0];
            if (prior && role) {
              if (!prior.result_enc) return "pending";
              const reply = JSON.parse(await decryptSecret(prior.result_enc, key));
              if (["request_outcome_unknown", "runtime_result_unavailable"].includes(reply.body?.error))
                return "pending";
              const receipt = readDockerPromptReceipt(reply, prior.epoch, commandId);
              const { conversationId } = JSON.parse(await decryptSecret(prior.request_enc, key)).input;
              if (
                receipt &&
                (conversationId === undefined || receipt.conversationId === conversationId) &&
                (prior.conversation_ids.length === 0 ||
                  (prior.conversation_ids.length === 1 && prior.conversation_ids[0] === receipt.conversationId))
              ) {
                await projectDockerPromptReceipt(
                  scopedRuntimeSql(tx),
                  { userId: prior.owner_id, orgId: request.org },
                  request.requestId,
                  prior.model,
                  commandId,
                  prior.epoch,
                  receipt,
                  prior.conversation_ids.length === 0,
                );
                const { promptId, conversationId } = receipt;
                const encrypted = await encryptSecret(
                  JSON.stringify({ epoch: prior.epoch, promptId, conversationId }),
                  key,
                );
                await recordDockerLaunchEvidence(tx, job.id, {
                  docker_receipt: Buffer.from(encrypted).toString("hex"),
                });
                if (manifest.template)
                  await templates.completeDockerLaunch(tx, manifest.template.id, request.requestId, {
                    ...receipt,
                    epoch: prior.epoch,
                  });
                return "published";
              }
            }
            if (
              await failDockerStartup(
                tx,
                request.requestId,
                generation,
                "docker_startup_failed",
                DOCKER_LAUNCH_FAILURE_MESSAGES.startup,
              )
            )
              await cancelDockerLaunchMailbox(tx, request.requestId, generation);
          },
          (tx) =>
            tx.query("select id from public.docker_hosts where id=$1 and org_id=$2 for update", [
              request.hostId,
              request.org,
            ]),
        );
        if (reconciled === "published") return { status: "done" as const };
        if (reconciled === "pending") return { status: "retry" as const, after: new Date(Date.now() + 1000) };
      }
      return { status: "fail" as const, reason: "docker_launch_inactive" };
    };
    if (!role || !(await context.canDispatch())) return settleInactive();
    try {
      const result = await continueRequest(manifest.correlationId, () =>
        observeProviderCall(
          "docker",
          "launch",
          () =>
            reconcile(
              { userId: membership.rows[0]!.user_id, orgs: [{ orgId: request.org, role }], via: "service" },
              request,
              { job, context },
            ).catch((error: unknown) => {
              if (error instanceof DockerMachinePending) return null;
              throw error;
            }),
          (result) => result && launched(result),
        ),
      );
      return result
        ? { status: "done" as const }
        : { status: "retry" as const, after: new Date(Date.now() + 1000), unattempted: true as const };
    } catch {
      if (!(await context.canDispatch())) return settleInactive();
      const retry = await sql.query(
        `select 1 from public.sandboxes s where s.id=$1 and s.lifecycle_generation=$2
          and s.status in ('starting','ready','running') and s.stop_requested_at is null`,
        [job.sandbox_id, job.generation],
      );
      return retry.rows.length
        ? { status: "retry" as const, after: new Date(Date.now() + 1000) }
        : { status: "fail" as const, reason: "docker_launch_failed" };
    }
  }
  return {
    admit: (caller: Caller, body: Record<string, unknown>, admission?: Parameters<typeof reserve>[2]) => {
      let operation = "launch";
      return observeProviderCall(
        "docker",
        () => operation,
        async () => {
          const result = await reserve(caller, body, admission);
          if (result.sandbox.status === "starting") operation = "launch.admit";
          return result;
        },
        launched,
        { replayable: true },
      );
    },
    run,
  };
}

export type AdmitHostLaunch = ReturnType<typeof createDockerLaunchPlacement>["admit"];
