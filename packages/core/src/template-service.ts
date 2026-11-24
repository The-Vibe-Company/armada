import { createHash } from "node:crypto";
import { parseApplicationSecretBindings } from "./application-secret-bindings.ts";
import type { ApplicationVaultActor } from "./application-vault.ts";
import type { ModalLaunchReceipt } from "./contract/launch-response.ts";
import { launchTemplateOperation } from "./contract/resources.ts";
import { HARNESS_KINDS } from "./credentials.ts";
import type { DockerLaunchResult } from "./docker-api.ts";
import type { GoldenActor, GoldenRecord } from "./golden.ts";
import { GoldenError } from "./golden-config.ts";
import type { LaunchOptions, LaunchRequest, LaunchStores } from "./golden-launch-admission.ts";
import { GOLDEN_SELECT, type GoldenRow, mapGoldenRow, type Sql } from "./golden-store.ts";
import { isHarness, runtimeHarnessSupported } from "./harnesses.ts";
import { LaunchError } from "./launch-error.ts";
import { assertLaunchSecretBindings, LaunchSecretRefusal, resolveLaunchSecrets } from "./launch-secrets.ts";
import { resolveLaunchVariables } from "./launch-variables.ts";
import { capabilities } from "./machine-capabilities.ts";
import { parseMachineSize } from "./machine-size.ts";
import { MAX_MCP_CONNECTIONS } from "./mcp-launch-selection.ts";
import { resolveModelChoice } from "./models.ts";
import { PRIVATE_SKILL_FAILURES } from "./private-skill-error.ts";
import { parseReadableVariableBindings, validateReadableVariables } from "./readable-variables.ts";
import { isExternalRef } from "./sandbox.ts";
import { isSandboxPlacementProvider } from "./sandbox-provider.ts";
import { createSkillDefaultsService } from "./skill-defaults.ts";
import { skillRefusalMessage } from "./skill-diagnostics.ts";
import { mergeSkillPins } from "./skill-merge.ts";
import { validateSkillPins } from "./skillpack.ts";
import type { LaunchTemplate, TemplateDefinition } from "./templates.ts";
import { VaultError, type VaultErrorCode } from "./vault-error.ts";

export class DockerTemplateAdmissionRefused extends Error {
  constructor(
    readonly reason: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface TemplateRuntime {
  stores: LaunchStores;
  /** Validate the selected definition at admission and the frozen definition on replay. */
  validateDefinition?(definition: TemplateDefinition): void | Promise<void>;
  explicitModal?: true;
  scheduled?: true;
  admitModal?(
    actor: GoldenActor,
    golden: GoldenRecord,
    request: LaunchRequest,
    pin: { id: string; credentialVersion: number; revalidate(tx: Sql): Promise<void> },
  ): Promise<ModalLaunchReceipt>;
  options?: Pick<LaunchOptions, "runtime" | "boatRuntime">;
  launchDocker?(
    body: Record<string, unknown>,
    admission: {
      beforeReserve(tx: Sql): Promise<void>;
      id: string;
      scheduled: boolean;
    },
  ): Promise<DockerLaunchResult>;
  fenceAdmission?(tx: Sql, sandboxId?: string): Promise<void>;
}
type Header = {
  id: string;
  org_id: string;
  owner_id: string;
  scope: "personal" | "org";
  name: string;
  current_revision: number;
  status: "active" | "deleted";
  created_at: string;
  updated_at: string;
};
type Revision = { id: string; revision: number; definition: TemplateDefinition; digest: string };
type Manifest = {
  version: 1;
  templateId: string;
  revisionId: string;
  revision: number;
  revisionHash: string;
  golden: GoldenRecord | null;
  host?: { installationId: string; ownerId: string };
  definition: TemplateDefinition;
  /** Frozen effective pins; absent on historical manifests. */
  resolvedSkills?: string[];
  connections: { id: string; version: number; generation: number }[];
  variables: Record<string, string>;
  variableProvenance: TemplateDefinition["variables"];
  account: { id: string; version: number };
  actorEpoch: number;
  actorId: string;
  requestKey: string;
};
type RequestRow = {
  actor_id: string;
  org_id: string;
  id: string;
  client_key: string;
  digest: string;
  manifest: Manifest;
  sandbox_id: string;
  state: string;
  result: Record<string, unknown> | null;
  reason: string | null;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never {
  throw new VaultError("invalid", "Invalid template request.");
}
function usesHostPlacement(
  definition: TemplateDefinition,
): definition is Extract<TemplateDefinition, { goldenId: null }> {
  return capabilities(definition.provider).launchSource === "host";
}
function unavailable(reason = "reference_unavailable"): never {
  throw new VaultError("conflict", `Template launch refused: ${reason}.`);
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  return input as Record<string, unknown>;
}
function fields(input: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(input).some((key) => !allowed.includes(key))) invalid();
}
function id(input: unknown): string {
  if (typeof input !== "string" || !uuid.test(input)) invalid();
  return input;
}
function integer(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) invalid();
  return input;
}
function text(input: unknown, max = 200): string {
  if (typeof input !== "string" || !input.trim() || input.length > max || input.includes("\0")) invalid();
  return input;
}
function canonical(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
  if (input && typeof input === "object")
    return `{${Object.entries(input)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(input);
}
function refusalReason(error: unknown): string | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 4; current = current.cause, depth++) {
    if (current instanceof LaunchError && current.skillFailure) return current.skillFailure.reason;
    // Public installs predate typed private-install diagnostics. Accept only their
    // closed classifications, never guest output or arbitrary exception messages.
    const skill = /^Skillpack installation failed: (skillpack_[a-z_]+)\./.exec(current.message)?.[1];
    if (skill && ([...PRIVATE_SKILL_FAILURES, "skillpack_skill_unavailable"] as readonly string[]).includes(skill))
      return skill;
    if (current instanceof VaultError) {
      const match = /^Template launch refused: ([a-z_]+)\.$/.exec(current.message);
      if (match) return match[1];
    }
  }
  return undefined;
}
const digest = (input: unknown) => createHash("sha256").update(canonical(input)).digest("hex");
function dto(h: Header): LaunchTemplate {
  return {
    id: h.id,
    orgId: h.org_id,
    ownerId: h.owner_id,
    scope: h.scope,
    name: h.name,
    currentRevision: h.current_revision,
    status: h.status,
    createdAt: h.created_at,
    updatedAt: h.updated_at,
  };
}

/** Every field the REST `templates/launch` route accepts; the published OpenAPI request lists exactly these. */
const templateLaunchFields = launchTemplateOperation.input.body.shape;
export const TEMPLATE_LAUNCH_FIELDS = Object.freeze(Object.keys(templateLaunchFields));

/** Service-role owner: both transports share validation, reference authorization and admission. */
export function createTemplateService(sql: Sql, encryptionKey?: string) {
  async function transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    if (!sql.transaction) throw new VaultError("unavailable", "Template transactions unavailable.");
    try {
      return await sql.transaction(work);
    } catch (error) {
      if (error instanceof VaultError || error instanceof GoldenError) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "23505")
        throw new VaultError("conflict", "Template name or request key already exists.");
      throw new VaultError("unavailable", "Template service unavailable.");
    }
  }
  async function member(tx: Sql, actor: ApplicationVaultActor, org: string): Promise<GoldenActor> {
    if (!actor.orgs.some((o) => o.orgId === org)) throw new VaultError("forbidden", "Template access denied.");
    const m = (
      await tx.query<{ role: "admin" | "member" }>(
        "select role from public.members where org_id=$1 and user_id=$2 for share",
        [org, actor.userId],
      )
    ).rows[0];
    if (!m) throw new VaultError("forbidden", "Template access denied.");
    return { userId: actor.userId, orgId: org, role: m.role };
  }
  async function header(tx: Sql, actor: GoldenActor, templateId: string, write = false, worker = false) {
    const h = (
      await tx.query<Header>(
        `select * from public.launch_templates where id=$1 and org_id=$2 and (scope='org' or owner_id=$3) ${worker ? "for share nowait" : "for update"}`,
        [templateId, actor.orgId, actor.userId],
      )
    ).rows[0];
    if (!h || h.status !== "active") throw new VaultError("not_found", "Template unavailable.");
    if (write && h.scope === "org" && actor.role !== "admin")
      throw new VaultError("forbidden", "Template administrator permission required.");
    return h;
  }
  async function revision(tx: Sql, h: Header, requested?: unknown): Promise<Revision> {
    const r = (
      await tx.query<Revision>(
        "select id,revision,definition,digest from public.launch_template_revisions where template_id=$1 and revision=$2",
        [h.id, requested === undefined ? h.current_revision : integer(requested)],
      )
    ).rows[0];
    if (!r) throw new VaultError("not_found", "Template revision unavailable.");
    return r;
  }
  async function golden(
    tx: Sql,
    actor: GoldenActor,
    scope: string,
    goldenId: string,
    provider: unknown,
    launchAdmission = false,
    worker = false,
  ) {
    const row = (
      await tx.query<GoldenRow>(
        `select ${GOLDEN_SELECT} from public.goldens where id=$1 and org_id=$2 and removed_at is null and (visibility='org' or owner_id=$3) for share${worker ? " nowait" : ""}`,
        [goldenId, actor.orgId, actor.userId],
      )
    ).rows[0];
    if (!row || row.provider !== provider || (scope === "org" && row.visibility !== "org")) {
      if (launchAdmission) throw new GoldenError("not_found", "No such golden.");
      unavailable("environment_unavailable");
    }
    if (!row.provider_snapshot_id) {
      if (launchAdmission) throw new GoldenError("conflict", `Golden '${row.name}' has no snapshot yet.`);
      unavailable("environment_unavailable");
    }
    return mapGoldenRow(row);
  }
  async function snapshotSealed(tx: Sql, provider: GoldenRecord["provider"], snapshot: string | null) {
    return (
      (
        await tx.query(
          "select 1 from public.golden_snapshot_retirements where provider=$1 and old_snapshot=$2 and sealed",
          [provider, snapshot],
        )
      ).rows.length > 0
    );
  }
  async function references(
    tx: Sql,
    actor: GoldenActor,
    scope: string,
    def: TemplateDefinition,
    enforceModelScope = true,
    expectedConnections?: Manifest["connections"],
    worker = false,
  ) {
    let g: GoldenRecord | null = null;
    let host: Manifest["host"];
    if (usesHostPlacement(def)) {
      // Issuer membership is observed here, not locked out of order after the actor.
      // The reservation rechecks this policy under its sorted actor/issuer prelocks.
      const row = (
        await tx.query<{ installation_id: string; owner_id: string }>(
          `select h.installation_id,h.owner_id from public.docker_hosts h
         join public.members issuer on issuer.org_id=h.org_id and issuer.user_id=h.owner_id
         where h.id=$1 and h.org_id=$2 and h.revoked_at is null and h.hash is not null
         and h.registration_hash is null for share of h`,
          [def.hostId, actor.orgId],
        )
      ).rows[0];
      if (!row) unavailable("environment_unavailable");
      host = { installationId: row.installation_id, ownerId: row.owner_id };
      if (def.snapshotId !== undefined) {
        // Ready snapshots are immutable and host-local. Recheck access and the
        // installation binding on every fresh admission, never on receipt replay.
        const snapshot = (
          await tx.query(
            `select s.id from public.docker_snapshots s
           where s.id=$1 and s.org_id=$2 and s.host_id=$3 and s.installation_id=$4
           and s.status='ready' and s.image_id is not null
           and (s.visibility='org' or s.owner_id=$5)
           and ($6::text<>'org' or s.visibility='org') for share of s`,
            [def.snapshotId, actor.orgId, def.hostId, row.installation_id, actor.userId, scope],
          )
        ).rows[0];
        if (!snapshot) unavailable("environment_snapshot_unavailable");
      }
    } else {
      g = await golden(tx, actor, scope, def.goldenId, def.provider, !enforceModelScope, worker);
      if (canonical(g.modal) !== canonical(def.goldenBinding)) unavailable("environment_binding_changed");
      if (await snapshotSealed(tx, g.provider, g.providerSnapshotId)) unavailable("environment_snapshot_unavailable");
    }
    const values = await resolveLaunchVariables(tx, actor, def.variables, scope === "org");
    await assertLaunchSecretBindings(tx, actor, def.secrets ?? [], scope === "org");
    try {
      validateReadableVariables(values);
    } catch {
      invalid();
    }
    const connections: Manifest["connections"] = [];
    for (const connectionId of def.connections) {
      const c = (
        await tx.query<{ version: number; generation: number; scope: string; status: string }>(
          `select g.version,g.generation,c.scope,public.mcp_grant_effective_status(g.status,g.revoked_at,g.refresh_consumed,g.refresh_until) as status from public.mcp_connections c join public.mcp_grants g on g.connection_id=c.id where c.id=$1 and c.org_id=$2 and not c.disabled and (c.scope='org' or c.owner_id=$3) for share of c,g`,
          [connectionId, actor.orgId, actor.userId],
        )
      ).rows[0];
      if (!c || c.status !== "connected" || (scope === "org" && c.scope !== "org"))
        unavailable("connection_unavailable");
      const expected = expectedConnections?.find((binding) => binding.id === connectionId);
      if (expectedConnections && (!expected || c.version !== expected.version || c.generation !== expected.generation))
        unavailable("connection_version_changed");
      connections.push({ id: connectionId, version: c.version, generation: c.generation });
    }
    if (def.modelAccount) {
      const c = (
        await tx.query<{ version: number; scope: string; kind: string; status: string }>(
          "select version,scope,kind,status from public.credentials where id=$1 and (expires_at is null or expires_at>now()) and ((scope='user' and owner_id=$2) or (scope='org' and owner_id=$3)) for share",
          [def.modelAccount.id, actor.userId, actor.orgId],
        )
      ).rows[0];
      if (!c || c.status !== "active" || (enforceModelScope && scope === "org" && c.scope !== "org"))
        unavailable("model_account_unavailable");
      if (c.version !== def.modelAccount.version) unavailable("model_account_version_changed");
      if (!HARNESS_KINDS[def.harness].some((kind) => kind === c.kind)) unavailable("model_account_incompatible");
    }
    return { golden: g, host, variables: values, connections };
  }
  async function definition(tx: Sql, actor: GoldenActor, scope: string, input: unknown): Promise<TemplateDefinition> {
    const d = object(input);
    fields(d, [
      "goldenId",
      "hostId",
      "snapshotId",
      "provider",
      "harness",
      "model",
      "reasoningEffort",
      "modelAccount",
      "connections",
      "variables",
      "secrets",
      "skills",
    ]);
    if (!isSandboxPlacementProvider(d.provider)) invalid();
    if (!isHarness(d.harness)) invalid();
    let choice: ReturnType<typeof resolveModelChoice>;
    try {
      choice = resolveModelChoice(d.harness, {
        ...(d.model === undefined ? {} : { model: text(d.model) }),
        ...(d.reasoningEffort === undefined ? {} : { reasoningEffort: text(d.reasoningEffort) }),
      });
    } catch {
      invalid();
    }
    const hostLaunch = capabilities(d.provider).launchSource === "host";
    const g = hostLaunch ? null : await golden(tx, actor, scope, id(d.goldenId), d.provider);
    if (hostLaunch) {
      id(d.hostId);
      if (d.snapshotId !== undefined) id(d.snapshotId);
      if (d.goldenId !== undefined && d.goldenId !== null) invalid();
    } else if (d.hostId !== undefined || d.snapshotId !== undefined) invalid();
    const connections: TemplateDefinition["connections"] = [];
    if (d.connections !== undefined && (!Array.isArray(d.connections) || d.connections.length > MAX_MCP_CONNECTIONS))
      invalid();
    for (const connection of (d.connections ?? []) as unknown[]) {
      const connectionId = id(connection);
      if (connections.includes(connectionId)) invalid();
      connections.push(connectionId);
    }
    let variables: TemplateDefinition["variables"];
    try {
      variables = parseReadableVariableBindings(d.variables === undefined ? [] : d.variables);
    } catch {
      invalid();
    }
    let secrets: NonNullable<TemplateDefinition["secrets"]>;
    try {
      secrets = parseApplicationSecretBindings(d.secrets === undefined ? [] : d.secrets);
    } catch {
      invalid();
    }
    if (secrets.some((secret) => variables.some((variable) => variable.key === secret.key))) invalid();
    if (variables.length + secrets.length > 64) unavailable("environment_limits_exceeded");
    const skills = (d.skills ?? []) as string[];
    if (!Array.isArray(skills)) invalid();
    try {
      validateSkillPins(skills);
    } catch {
      invalid();
    }
    let modelAccount: TemplateDefinition["modelAccount"];
    if (d.modelAccount !== undefined) {
      const a = object(d.modelAccount);
      fields(a, ["id", "version"]);
      modelAccount = { id: id(a.id), version: integer(a.version) };
    }
    const result: TemplateDefinition = {
      ...(g
        ? { goldenId: g.id, provider: g.provider, goldenBinding: g.modal }
        : {
            goldenId: null,
            provider: "docker" as const,
            goldenBinding: null,
            hostId: id(d.hostId),
            ...(d.snapshotId === undefined ? {} : { snapshotId: id(d.snapshotId) }),
          }),
      harness: d.harness,
      ...choice,
      connections,
      variables,
      ...(secrets.length ? { secrets } : {}),
      skills,
      ...(modelAccount ? { modelAccount } : {}),
    };
    await references(tx, actor, scope, result);
    return result;
  }
  async function epoch(tx: Sql, actor: GoldenActor) {
    return Number(
      (
        await tx.query<{ epoch: string }>(
          "select epoch from public.mcp_actor_epochs where org_id=$1 and user_id=$2 for share",
          [actor.orgId, actor.userId],
        )
      ).rows[0]?.epoch ?? 0,
    );
  }
  async function saveRevision(tx: Sql, h: Header, actor: GoldenActor, def: TemplateDefinition) {
    const r = (
      await tx.query<Revision>(
        "insert into public.launch_template_revisions(template_id,revision,definition,digest,created_by) values($1,$2,$3::text::jsonb,$4,$5) returning id,revision,definition,digest",
        [h.id, h.current_revision, JSON.stringify(def), digest(def), actor.userId],
      )
    ).rows[0]!;
    return { item: dto(h), revision: r };
  }
  async function command(
    actor: ApplicationVaultActor,
    operation: string,
    input: Record<string, unknown>,
    runtime?: TemplateRuntime,
  ): Promise<Record<string, unknown>> {
    const allowed: Record<string, string[]> = {
      create: ["org", "name", "scope", "definition"],
      list: ["org"],
      get: ["org", "id", "revision"],
      publish: ["org", "id", "expectedRevision", "definition"],
      delete: ["org", "id", "expectedRevision"],
      launch: [...TEMPLATE_LAUNCH_FIELDS],
    };
    if (!allowed[operation]) invalid();
    fields(input, allowed[operation]!);
    const org = id(input.org);
    if (operation === "launch") {
      try {
        return await launch(actor, org, input, runtime);
      } catch (error) {
        // Pre-claim golden admission has no durable request yet, but its public
        // refusal must use the same outcome contract as post-claim refusals.
        if (error instanceof GoldenError) {
          if (runtime?.explicitModal) throw error;
          return { state: "failed", reason: error.code, message: error.message };
        }
        const reason = refusalReason(error);
        // Closed reason only: never log credential errors, request bodies or readable values.
        if (reason) console.warn("armada: template launch refused", { reason, templateId: id(input.id), orgId: org });
        throw error;
      }
    }
    return transaction(async (tx) => {
      const a = await member(tx, actor, org);
      if (operation === "list")
        return {
          items: (
            await tx.query<Header>(
              "select * from public.launch_templates where org_id=$1 and (scope='org' or owner_id=$2) and status='active' order by name,id",
              [org, a.userId],
            )
          ).rows.map(dto),
        };
      if (operation === "create") {
        if (input.scope !== "personal" && input.scope !== "org") invalid();
        if (input.scope === "org" && a.role !== "admin")
          throw new VaultError("forbidden", "Template administrator permission required.");
        const def = await definition(tx, a, input.scope, input.definition);
        const h = (
          await tx.query<Header>(
            "insert into public.launch_templates(org_id,owner_id,scope,name) values($1,$2,$3,$4) returning *",
            [org, a.userId, input.scope, text(input.name)],
          )
        ).rows[0]!;
        return saveRevision(tx, h, a, def);
      }
      const h = await header(tx, a, id(input.id), operation !== "get");
      if (operation === "get") return { item: dto(h), revision: await revision(tx, h, input.revision) };
      if (h.current_revision !== integer(input.expectedRevision))
        throw new VaultError("conflict", "Template revision changed.");
      if (operation === "delete") {
        const deleted = (
          await tx.query<Header>(
            "update public.launch_templates set status='deleted',updated_at=now() where id=$1 returning *",
            [h.id],
          )
        ).rows[0]!;
        return { item: dto(deleted) };
      }
      const def = await definition(tx, a, h.scope, input.definition);
      const next = (
        await tx.query<Header>(
          "update public.launch_templates set current_revision=current_revision+1,updated_at=now() where id=$1 returning *",
          [h.id],
        )
      ).rows[0]!;
      return saveRevision(tx, next, a, def);
    });
  }
  async function launch(
    actor: ApplicationVaultActor,
    org: string,
    input: Record<string, unknown>,
    runtime?: TemplateRuntime,
  ): Promise<Record<string, unknown>> {
    if (!runtime) throw new VaultError("unavailable", "Template launching unavailable.");
    id(input.id);
    const key = input.requestKey;
    if (typeof key !== "string") invalid();
    const validKey = runtime.explicitModal
      ? /^pinned-modal\/[a-f0-9]{64}$/.test(key)
      : templateLaunchFields.requestKey.safeParse(key).success;
    if (!validKey || key.startsWith("routine:") !== Boolean(runtime.scheduled)) invalid();
    if (runtime.scheduled && !runtime.fenceAdmission) unavailable("environment_admission_unavailable");
    if (input.revision !== undefined) integer(input.revision);
    if (!templateLaunchFields.prompt.safeParse(input.prompt).success) invalid();
    if (input.ttlSeconds !== undefined) integer(input.ttlSeconds);
    if (!templateLaunchFields.repo.safeParse(input.repo).success) invalid();
    if (input.skipSkillDefaults !== undefined && typeof input.skipSkillDefaults !== "boolean") invalid();
    if (input.externalRef !== undefined && !isExternalRef(input.externalRef)) invalid();
    if (input.stopWhenWorkMerged !== undefined && typeof input.stopWhenWorkMerged !== "boolean") invalid();
    try {
      validateSkillPins(input.skills ?? []);
    } catch {
      invalid();
    }
    const size = input.size === undefined ? undefined : parseMachineSize(input.size);
    // An explicit enrolled-runtime request must not adopt a native template
    // request key (or vice versa). Preserve historical/native digests unchanged.
    const bodyDigest = digest(
      runtime.explicitModal || runtime.options?.runtime || runtime.options?.boatRuntime
        ? { input, runtime: "armada" }
        : input,
    );
    // Resolve a model account before the claim, then revalidate that binding inside admission.
    const existing = await transaction(async (tx) => {
      await member(tx, actor, org);
      return (
        await tx.query<RequestRow>(
          "select * from public.template_launch_requests where org_id=$1 and actor_id=$2 and client_key=$3",
          [org, actor.userId, key],
        )
      ).rows[0];
    });
    if (existing) return resume(existing);
    const selection = await transaction(async (tx) => {
      const a = await member(tx, actor, org);
      const h = await header(tx, a, id(input.id));
      return { a, h, r: await revision(tx, h, input.revision) };
    });
    const def = selection.r.definition;
    if (!runtimeHarnessSupported(def.provider, def.harness)) unavailable("environment_admission_unavailable");
    // Host launches record no external reference; refuse rather than drop it.
    if (input.externalRef !== undefined && usesHostPlacement(def)) unavailable("external_ref_unavailable");
    await runtime.validateDefinition?.(def);
    let account = def.modelAccount;
    if (input.modelAccount !== undefined) {
      if (account) invalid(); // A launch never overrides a revision's pinned billing account.
      const requested = object(input.modelAccount);
      fields(requested, ["id", "version"]);
      account = { id: id(requested.id), version: integer(requested.version) };
    }

    const credentials = await runtime.stores.credentials
      .resolve(selection.a, def.harness, account?.id, account?.version)
      .catch((error: unknown) => {
        // These are model-resolution failures, not a missing template/revision. Keep unrelated
        // infrastructure and authorization failures intact rather than hiding them as account problems.
        if (error instanceof VaultError && error.code === "conflict") unavailable("model_account_ambiguous");
        throw error;
      });
    if (!credentials.binding) unavailable("model_account_unavailable");
    if (
      account &&
      (account.id !== credentials.binding.credentialId || account.version !== credentials.binding.credentialVersion)
    )
      unavailable("model_account_version_changed");
    const request = await transaction(async (tx) => {
      const a = await member(tx, actor, org);
      const h = await header(tx, a, id(input.id));
      const previous = (
        await tx.query<RequestRow>(
          "select * from public.template_launch_requests where org_id=$1 and actor_id=$2 and client_key=$3",
          [org, a.userId, key],
        )
      ).rows[0];
      if (previous) return previous;
      const r = await revision(tx, h, input.revision);
      if (r.id !== selection.r.id) unavailable("template_revision_changed");
      const resolved = await references(
        tx,
        a,
        h.scope,
        {
          ...def,
          modelAccount: { id: credentials.binding!.credentialId, version: credentials.binding!.credentialVersion },
        },
        false,
      );
      const defaults = input.skipSkillDefaults
        ? undefined
        : await createSkillDefaultsService(tx).resolveInTransaction(a, resolved.golden);
      let resolvedSkills: string[];
      try {
        resolvedSkills = mergeSkillPins(
          defaults?.environment ?? [],
          defaults?.org ?? [],
          defaults?.personal ?? [],
          def.skills,
          (input.skills ?? []) as string[],
        );
      } catch {
        invalid();
      }
      const manifest: Manifest = {
        version: 1,
        templateId: h.id,
        revisionId: r.id,
        revision: r.revision,
        revisionHash: r.digest,
        golden: resolved.golden,
        ...(resolved.host ? { host: resolved.host } : {}),
        definition: def,
        resolvedSkills,
        connections: resolved.connections,
        variables: resolved.variables,
        variableProvenance: def.variables,
        account: { id: credentials.binding!.credentialId, version: credentials.binding!.credentialVersion },
        actorEpoch: await epoch(tx, a),
        actorId: a.userId,
        requestKey: key,
      };
      const sandboxId = crypto.randomUUID();
      const result = (
        await tx.query<RequestRow>(
          "insert into public.template_launch_requests(org_id,actor_id,client_key,digest,template_id,revision_id,manifest,sandbox_id) values($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8) on conflict(org_id,actor_id,client_key) do nothing returning *",
          [org, a.userId, key, bodyDigest, h.id, r.id, JSON.stringify(manifest), sandboxId],
        )
      ).rows[0];
      if (!result)
        return (
          await tx.query<RequestRow>(
            "select * from public.template_launch_requests where org_id=$1 and actor_id=$2 and client_key=$3",
            [org, a.userId, key],
          )
        ).rows[0]!;
      return result;
    });
    function launchRequest(m: Manifest) {
      return {
        credentialId: m.account.id,
        harness: m.definition.harness,
        model: m.definition.model,
        reasoningEffort: m.definition.reasoningEffort,
        connections: m.definition.connections,
        skills: m.resolvedSkills ?? m.definition.skills,
        skipSkillDefaults: true as const,
        ...(input.stopWhenWorkMerged === false ? { stopWhenWorkMerged: false } : {}),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt as string }),
        ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds as number }),
      };
    }
    async function admitDocker(row: RequestRow) {
      const m = row.manifest;
      const placement = m.definition;
      try {
        if (
          !usesHostPlacement(placement) ||
          !runtime!.launchDocker ||
          !m.host ||
          input.repo !== undefined ||
          size !== undefined
        )
          unavailable("environment_admission_unavailable");
        await runtime!.launchDocker(
          {
            ...launchRequest(m),
            org,
            provider: "docker",
            hostId: placement.hostId,
            ...(placement.snapshotId === undefined ? {} : { snapshotId: placement.snapshotId }),
            credentialVersion: m.account.version,
            requestId: row.sandbox_id,
            variables: placement.variables,
            secrets: placement.secrets ?? [],
          },
          {
            id: row.id,
            scheduled: runtime!.scheduled === true,
            beforeReserve: async (tx) => {
              await revalidateInTransaction(tx, actor, org, m);
              if (runtime!.fenceAdmission) await runtime!.fenceAdmission(tx, row.sandbox_id);
              const changed = await tx.query(
                `update public.template_launch_requests set state='allocating',updated_at=now()
               where id=$1 and state='claimed' returning id`,
                [row.id],
              );
              if (!changed.rows.length) unavailable("environment_admission_unavailable");
            },
          },
        );
      } catch (error) {
        const reason =
          refusalReason(error) ?? (error instanceof DockerTemplateAdmissionRefused ? error.reason : undefined);
        if (!reason) throw error;
        const failure = {
          requestId: row.id,
          state: "failed",
          id: row.sandbox_id,
          reason,
          message:
            error instanceof DockerTemplateAdmissionRefused || error instanceof VaultError ? error.message : undefined,
          manifest: m,
        };
        const changed = await transaction(async (tx) => {
          await runtime!.fenceAdmission?.(tx);
          return tx.query(
            `update public.template_launch_requests set state='failed',reason=$2,result=$3::jsonb,updated_at=now()
             where id=$1 and state='claimed' returning id`,
            [row.id, reason, JSON.stringify(failure)],
          );
        });
        if (changed.rows.length) return failure;
        const current = (
          await sql.query<RequestRow>("select * from public.template_launch_requests where id=$1", [row.id])
        ).rows[0];
        if (!current) throw error;
        return resume(current);
      }
      return dockerAdmissionReceipt(row);
    }

    function dockerAdmissionReceipt(row: RequestRow) {
      return {
        requestId: row.id,
        state: "succeeded",
        id: row.sandbox_id,
        provider: "docker",
        status: "starting",
        manifest: row.manifest,
      };
    }

    async function resume(row: RequestRow, admittedActor?: GoldenActor): Promise<Record<string, unknown>> {
      const active = runtime!;
      const previous = await replay(row, bodyDigest, active);
      const m = row.manifest;
      if (usesHostPlacement(m.definition)) {
        if (row.state === "claimed") return admitDocker(row);
        if (row.state === "allocating" && !row.result) {
          const failed = await sql.query(
            `select 1 from public.jobs where sandbox_id=$1 and kind='launch' and state='failed'
             and outcome ? 'docker_actor_epoch'`,
            [row.sandbox_id],
          );
          if (failed.rows.length) return { ...previous, state: "failed", reason: "launch_unavailable" };
          return dockerAdmissionReceipt(row);
        }
        return previous;
      }
      if (!m.golden || row.state !== "claimed" || row.result) return previous;
      if (!active.admitModal) unavailable("environment_admission_unavailable");
      const a = admittedActor ?? (await transaction((tx) => member(tx, actor, org)));
      const g = m.golden;
      try {
        await active.admitModal(
          a,
          g,
          {
            golden: g.name,
            provider: g.provider,
            ...launchRequest(m),
            ...(size === undefined ? {} : { size }),
            ...(input.repo === undefined ? {} : { repo: input.repo as string }),
            ...(input.externalRef === undefined ? {} : { externalRef: input.externalRef as string }),
          },
          {
            id: row.id,
            credentialVersion: m.account.version,
            revalidate: async (tx) => {
              await revalidateInTransaction(tx, actor, org, m);
              const secrets = await resolveLaunchSecrets(tx, a, m.definition.secrets ?? [], encryptionKey);
              try {
                validateReadableVariables({ ...m.variables, ...secrets });
              } catch {
                unavailable("environment_limits_exceeded");
              }
              await active.fenceAdmission?.(tx, row.sandbox_id);
            },
          },
        );
      } catch (error) {
        if (
          !(error instanceof GoldenError || error instanceof VaultError || error instanceof LaunchError) ||
          error.code === "unavailable" ||
          error.code === "outcome_unknown"
        )
          throw error;
        const reason = refusalReason(error) ?? error.code;
        await transaction(async (tx) => {
          await active.fenceAdmission?.(tx);
          await tx.query(
            `update public.template_launch_requests set state='failed',reason=$2,result=$3::jsonb,updated_at=now()
             where id=$1 and state='claimed' and result is null`,
            [
              row.id,
              reason,
              JSON.stringify({
                requestId: row.id,
                state: "failed",
                id: row.sandbox_id,
                reason,
                failureCode: error.code,
                manifest: m,
                ...(error instanceof VaultError ? { message: error.message, vaultCode: error.code } : {}),
              }),
            ],
          );
        });
      }
      const current = (
        await sql.query<RequestRow>("select * from public.template_launch_requests where id=$1", [row.id])
      ).rows[0];
      if (!current || current.state === "claimed") unavailable("environment_admission_unavailable");
      return replay(current, bodyDigest, active);
    }
    return resume(request, selection.a);
  }
  async function replay(row: RequestRow, bodyDigest: string, runtime: TemplateRuntime) {
    if (row.digest !== bodyDigest)
      throw new VaultError("conflict", "Request key already used with a different request.");
    // Validate explicit selectors against the frozen definition without reading a live template
    // or changing historical request digests.
    await runtime.validateDefinition?.(row.manifest.definition);
    if (
      row.state === "failed" &&
      row.result?.code === "conflict" &&
      (row.reason === "secret_unavailable" || row.reason === "secret_version_changed")
    )
      throw new LaunchSecretRefusal(row.reason);
    if (!runtime.scheduled && row.state === "failed" && row.result?.vaultCode && typeof row.result.message === "string")
      throw new VaultError(row.result.vaultCode as VaultErrorCode, row.result.message);
    const output = row.result ?? {
      requestId: row.id,
      state: row.state,
      id: row.sandbox_id,
      reason: row.reason,
      ...(row.reason?.startsWith("skillpack_")
        ? {
            message: skillRefusalMessage(row.reason),
          }
        : {}),
      manifest: row.manifest,
    };
    return output;
  }
  async function revalidateInTransaction(
    tx: Sql,
    actor: ApplicationVaultActor,
    org: string,
    m: Manifest,
    worker = false,
  ) {
    const a = await member(tx, actor, org);
    const h = await header(tx, a, m.templateId, false, worker);
    if ((await epoch(tx, a)) !== m.actorEpoch) unavailable("authorization_changed");
    const resolved = await references(
      tx,
      a,
      h.scope,
      { ...m.definition, modelAccount: m.account },
      false,
      m.connections,
      worker,
    );
    if (canonical(resolved.host) !== canonical(m.host)) unavailable("environment_binding_changed");
    return resolved.golden;
  }
  async function validateBindingInTransaction(tx: Sql, actor: ApplicationVaultActor, org: string, templateId: string) {
    const a = await member(tx, actor, org);
    if (a.role !== "admin") throw new VaultError("forbidden", "Organization admin access is required.");
    const h = await header(tx, a, templateId);
    const { definition } = await revision(tx, h);
    const { host } = await references(tx, a, h.scope, definition);
    if (host) {
      const { rows } = await tx.query(
        "select 1 from public.members where org_id = $1 and user_id = $2 for share nowait",
        [org, host.ownerId],
      );
      if (!rows.length) unavailable("environment_unavailable");
    }
    return { harness: definition.harness, modelAccount: definition.modelAccount };
  }
  async function revalidateDockerLaunch(
    tx: Sql,
    actor: { userId: string; orgId: string },
    sandboxId: string,
    pin: { id: string; scheduled: boolean },
    revalidateReferences = false,
  ) {
    const row = (
      await tx.query<RequestRow>(
        `select c.* from public.template_launch_requests c
         join public.launch_templates t on t.id=c.template_id and t.org_id=c.org_id
         where c.id=$1 and c.sandbox_id=$2 and c.actor_id=$3 and c.org_id=$4 and c.state='allocating'
         and t.status='active' and (t.scope='org' or t.owner_id=c.actor_id)
         ${revalidateReferences ? "" : "for share of t nowait"}`,
        [pin.id, sandboxId, actor.userId, actor.orgId],
      )
    ).rows[0];
    if (!row || !usesHostPlacement(row.manifest.definition)) unavailable("environment_admission_unavailable");
    if (pin.scheduled) {
      const grant = await tx.query(
        `select 1 from public.routine_runs run join public.routines r on r.id=run.routine_id
         join public.members m on m.org_id=r.org_id and m.user_id=run.owner_id
         where run.request_key=$1 and run.owner_id=$2 and run.org_id=$3
         and (r.scope='personal' or m.role='admin') for share of r,m nowait`,
        [row.client_key, actor.userId, actor.orgId],
      );
      if (!grant.rows.length) throw new VaultError("forbidden", "Routine owner authorization changed.");
    }
    if (revalidateReferences)
      await revalidateInTransaction(tx, { userId: actor.userId, orgs: [actor] }, actor.orgId, row.manifest);
  }

  async function revalidateGoldenJob(tx: Sql, sandboxId: string, receiptId: string) {
    const row = (
      await tx.query<RequestRow>(
        "select * from public.template_launch_requests where sandbox_id=$1 and id=$2 and state='succeeded'",
        [sandboxId, receiptId],
      )
    ).rows[0];
    if (!row) unavailable("environment_admission_unavailable");
    if (row.client_key.startsWith("routine:")) {
      const grant = await tx.query(
        `select 1 from public.routine_runs run join public.routines r on r.id=run.routine_id
         join public.members m on m.org_id=r.org_id and m.user_id=run.owner_id
         where run.request_key=$1 and run.owner_id=$2 and run.org_id=$3
         and (r.scope='personal' or m.role='admin') for share of r,m nowait`,
        [row.client_key, row.actor_id, row.org_id],
      );
      if (!grant.rows.length) throw new VaultError("forbidden", "Routine owner authorization changed.");
    }
    const actor = { userId: row.actor_id, orgs: [{ orgId: row.org_id }] };
    await revalidateInTransaction(tx, actor, row.org_id, row.manifest, true);
  }

  async function completeDockerLaunch(
    tx: Sql,
    requestId: string,
    sandboxId: string,
    receipt: { epoch: string; promptId?: string; conversationId?: string },
  ) {
    await tx.query(
      `update public.template_launch_requests r set state='succeeded',updated_at=now(),
         result=jsonb_build_object('requestId',r.id,'id',s.id,'state','succeeded',
           'provider',s.provider,'status',s.status,'providerSandboxId',s.provider_sandbox_id,
           'runtime',jsonb_build_object('kind','armada','epoch',$3::text),
           'promptId',$4::text,'conversationId',$5::text,
           'manifest',r.manifest || jsonb_build_object('skillReceipts',s.skills))
       from public.sandboxes s where r.id=$1 and r.sandbox_id=$2 and s.id=r.sandbox_id and r.state='allocating'`,
      [requestId, sandboxId, receipt.epoch, receipt.promptId ?? null, receipt.conversationId ?? null],
    );
  }

  return { command, validateBindingInTransaction, revalidateDockerLaunch, revalidateGoldenJob, completeDockerLaunch };
}
export type TemplateService = ReturnType<typeof createTemplateService>;
