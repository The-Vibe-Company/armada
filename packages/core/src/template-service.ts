import { createHash } from "node:crypto";
import type { ApplicationVaultActor } from "./application-vault.ts";
import type { GoldenActor, GoldenOperation, GoldenRecord } from "./golden.ts";
import { GOLDEN_SELECT, type GoldenRow, mapGoldenRow, type Sql } from "./golden-store.ts";
import { type LaunchOptions, type LaunchStores, launchSandbox } from "./launch.ts";
import { LaunchError } from "./launch-error.ts";
import { PRIVATE_SKILL_FAILURES } from "./private-skill-error.ts";
import { parseMachineSize } from "./machine-size.ts";
import { resolveModelChoice } from "./models.ts";
import type { Provider } from "./provider.ts";
import { validateReadableVariables } from "./readable-variables.ts";
import { validateSkillPins } from "./skillpack.ts";
import type { LaunchTemplate, TemplateDefinition } from "./templates.ts";
import { VaultError } from "./vault-error.ts";

export interface TemplateRuntime {
  stores: LaunchStores;
  provider(golden: GoldenRecord): Promise<Provider>;
  options?: LaunchOptions;
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
  golden: GoldenRecord;
  definition: TemplateDefinition;
  connections: { id: string; version: number; generation: number }[];
  variables: Record<string, string>;
  variableProvenance: TemplateDefinition["variables"];
  account: { id: string; version: number };
  actorEpoch: number;
  actorId: string;
  requestKey: string;
};
type RequestRow = {
  id: string;
  digest: string;
  manifest: Manifest;
  sandbox_id: string;
  golden_operation_fence_id: string;
  state: string;
  result: Record<string, unknown> | null;
  reason: string | null;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never {
  throw new VaultError("invalid", "Invalid template request.");
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
    if (skill && [...PRIVATE_SKILL_FAILURES, "skillpack_skill_unavailable"].includes(skill as never)) return skill;
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

/** Service-role owner: both transports share validation, reference authorization and admission. */
export function createTemplateService(sql: Sql) {
  async function transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    if (!sql.transaction) throw new VaultError("unavailable", "Template transactions unavailable.");
    try {
      return await sql.transaction(work);
    } catch (error) {
      if (error instanceof VaultError) throw error;
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
  async function header(tx: Sql, actor: GoldenActor, templateId: string, write = false) {
    const h = (
      await tx.query<Header>(
        "select * from public.launch_templates where id=$1 and org_id=$2 and (scope='org' or owner_id=$3) for update",
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
  async function golden(tx: Sql, actor: GoldenActor, scope: string, goldenId: string, provider: unknown) {
    const row = (
      await tx.query<GoldenRow>(
        `select ${GOLDEN_SELECT} from public.goldens where id=$1 and org_id=$2 and removed_at is null and (visibility='org' or owner_id=$3) for share`,
        [goldenId, actor.orgId, actor.userId],
      )
    ).rows[0];
    if (!row || row.provider !== provider || !row.provider_snapshot_id || (scope === "org" && row.visibility !== "org"))
      unavailable("environment_unavailable");
    return mapGoldenRow(row);
  }
  async function references(
    tx: Sql,
    actor: GoldenActor,
    scope: string,
    def: TemplateDefinition,
    enforceModelScope = true,
    expectedConnections?: Manifest["connections"],
  ) {
    const g = await golden(tx, actor, scope, def.goldenId, def.provider);
    if (canonical(g.modal) !== canonical(def.goldenBinding)) unavailable("environment_binding_changed");
    const retired = (
      await tx.query(
        "select 1 from public.golden_snapshot_retirements where provider=$1 and old_snapshot=$2 and sealed",
        [g.provider, g.providerSnapshotId],
      )
    ).rows.length;
    if (retired) unavailable("environment_snapshot_unavailable");
    const values: Record<string, string> = {};
    for (const binding of def.variables) {
      const v = (
        await tx.query<{ value: string; version: number; scope: string; owner_id: string }>(
          "select value,version,scope,owner_id from public.readable_variables where id=$1 and org_id=$2 and status='active' and (scope='org' or owner_id=$3) for share",
          [binding.variableId, actor.orgId, actor.userId],
        )
      ).rows[0];
      if (!v || (scope === "org" && v.scope !== "org")) unavailable("variable_unavailable");
      if (v.version !== binding.version) unavailable("variable_version_changed");
      values[binding.key] = v.value;
    }
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
      if (!(def.harness === "codex" ? ["openai", "codex_auth"] : ["anthropic", "claude_oauth"]).includes(c.kind))
        unavailable("model_account_incompatible");
    }
    return { golden: g, variables: values, connections };
  }
  async function definition(tx: Sql, actor: GoldenActor, scope: string, input: unknown): Promise<TemplateDefinition> {
    const d = object(input);
    fields(d, [
      "goldenId",
      "provider",
      "harness",
      "model",
      "reasoningEffort",
      "modelAccount",
      "connections",
      "variables",
      "skills",
    ]);
    if (d.provider !== "boat" && d.provider !== "modal") invalid();
    if (d.harness !== "claude" && d.harness !== "codex") invalid();
    let choice: ReturnType<typeof resolveModelChoice>;
    try {
      choice = resolveModelChoice(d.harness, {
        ...(d.model === undefined ? {} : { model: text(d.model) }),
        ...(d.reasoningEffort === undefined ? {} : { reasoningEffort: text(d.reasoningEffort) }),
      });
    } catch {
      invalid();
    }
    const g = await golden(tx, actor, scope, id(d.goldenId), d.provider);
    const connections: TemplateDefinition["connections"] = [];
    if (d.connections !== undefined && (!Array.isArray(d.connections) || d.connections.length > 100)) invalid();
    for (const connection of (d.connections ?? []) as unknown[]) {
      const connectionId = id(connection);
      if (connections.includes(connectionId)) invalid();
      connections.push(connectionId);
    }
    const variables: TemplateDefinition["variables"] = [];
    if (d.variables !== undefined && (!Array.isArray(d.variables) || d.variables.length > 64)) invalid();
    for (const binding of (d.variables ?? []) as unknown[]) {
      const b = object(binding);
      fields(b, ["key", "variableId", "version"]);
      const key = text(b.key, 128);
      try {
        validateReadableVariables({ [key]: "" });
      } catch {
        invalid();
      }
      if (variables.some((v) => v.key === key)) invalid();
      variables.push({ key, variableId: id(b.variableId), version: integer(b.version) });
    }
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
      goldenId: g.id,
      provider: g.provider,
      goldenBinding: g.modal,
      harness: d.harness,
      ...choice,
      connections,
      variables,
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
      launch: ["org", "id", "revision", "requestKey", "prompt", "ttlSeconds", "size", "repo"],
    };
    if (!allowed[operation]) invalid();
    fields(input, allowed[operation]!);
    const org = id(input.org);
    if (operation === "launch") {
      try {
        return await launch(actor, org, input, runtime);
      } catch (error) {
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
    const key = text(input.requestKey, 128);
    if (!/^[A-Za-z0-9._:-]+$/.test(key)) invalid();
    if (input.revision !== undefined) integer(input.revision);
    if (input.prompt !== undefined) text(input.prompt, 100000);
    if (input.ttlSeconds !== undefined) integer(input.ttlSeconds);
    if (input.repo !== undefined) text(input.repo);
    const size = input.size === undefined ? undefined : parseMachineSize(input.size);
    const bodyDigest = digest(input);
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
    if (existing) return replay(existing, bodyDigest);
    const selection = await transaction(async (tx) => {
      const a = await member(tx, actor, org);
      const h = await header(tx, a, id(input.id));
      return { a, h, r: await revision(tx, h, input.revision) };
    });
    const def = selection.r.definition;
    const credentials = await runtime.stores.credentials
      .resolve(selection.a, def.harness, def.modelAccount?.id, def.modelAccount?.version)
      .catch((error: unknown) => {
        // These are model-resolution failures, not a missing template/revision. Keep unrelated
        // infrastructure and authorization failures intact rather than hiding them as account problems.
        if (error instanceof VaultError && error.code === "missing_credential")
          unavailable("model_account_unavailable");
        if (error instanceof VaultError && error.code === "conflict") unavailable("model_account_ambiguous");
        if (error instanceof VaultError && error.code === "credential_refused") unavailable("model_account_refused");
        throw error;
      });
    if (!credentials.binding) unavailable("model_account_unavailable");
    if (
      def.modelAccount &&
      (def.modelAccount.id !== credentials.binding.credentialId ||
        def.modelAccount.version !== credentials.binding.credentialVersion)
    )
      unavailable("model_account_version_changed");
    let claimed = false;
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
      // Acquire the strongest row lock FIRST: fence insertion also takes FOR UPDATE.
      // Taking FOR SHARE in references before this would allow concurrent lock upgrades.
      await tx.query("select id from public.goldens where id=$1 for update", [def.goldenId]);
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
      const manifest: Manifest = {
        version: 1,
        templateId: h.id,
        revisionId: r.id,
        revision: r.revision,
        revisionHash: r.digest,
        golden: resolved.golden,
        definition: def,
        connections: resolved.connections,
        variables: resolved.variables,
        variableProvenance: def.variables,
        account: { id: credentials.binding!.credentialId, version: credentials.binding!.credentialVersion },
        actorEpoch: await epoch(tx, a),
        actorId: a.userId,
        requestKey: key,
      };
      const sandboxId = crypto.randomUUID();
      const fenceId = crypto.randomUUID();
      const result = (
        await tx.query<RequestRow>(
          "insert into public.template_launch_requests(org_id,actor_id,client_key,digest,template_id,revision_id,manifest,sandbox_id,golden_operation_fence_id) values($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8,$9) on conflict(org_id,actor_id,client_key) do nothing returning *",
          [org, a.userId, key, bodyDigest, h.id, r.id, JSON.stringify(manifest), sandboxId, fenceId],
        )
      ).rows[0];
      if (!result)
        return (
          await tx.query<RequestRow>(
            "select * from public.template_launch_requests where org_id=$1 and actor_id=$2 and client_key=$3",
            [org, a.userId, key],
          )
        ).rows[0]!;
      // Snapshot A is protected in the SAME transaction that claims the request.
      // Existing retirement guards now see the reference before any provider/credential await.
      await tx.query(
        "insert into public.golden_operation_fences(id,golden_id,expected_snapshot_id,expected_sandbox_id,revision_known,operation_kind) values($1,$2,$3,$4,true,'launch')",
        [fenceId, resolved.golden.id, resolved.golden.providerSnapshotId, resolved.golden.providerSandboxId],
      );
      claimed = true;
      return result;
    });
    if (!claimed) return replay(request, bodyDigest);
    const m = request.manifest;
    let allocating = false;
    let fenceConsumed = false;
    // These handles deliberately use root SQL, never the ended claim transaction connection.
    const releaseFence: GoldenOperation = async () => {
      await sql.query("delete from public.golden_operation_fences where id=$1", [request.golden_operation_fence_id]);
    };
    releaseFence.retain = async (receipt) => {
      await sql.query("update public.golden_operation_fences set receipt=$2::text::jsonb where id=$1", [
        request.golden_operation_fence_id,
        JSON.stringify(receipt),
      ]);
    };
    try {
      const provider = await runtime.provider(m.golden);
      if (def.variables.length && !provider.configureReadableVariables) unavailable("variable_delivery_unavailable");
      const result = await launchSandbox(
        provider,
        {
          ...runtime.stores,
          goldens: {
            ...runtime.stores.goldens,
            findByName: async () => [m.golden],
            beginOperation: async (goldenId, expected) => {
              if (
                fenceConsumed ||
                goldenId !== m.golden.id ||
                expected.kind !== "launch" ||
                expected.snapshotId !== m.golden.providerSnapshotId ||
                expected.sandboxId !== m.golden.providerSandboxId
              )
                unavailable("environment_admission_unavailable");
              const fence = (
                await sql.query(
                  "select id from public.golden_operation_fences where id=$1 and golden_id=$2 and expected_snapshot_id=$3 and expected_sandbox_id is not distinct from $4::text and revision_known and operation_kind='launch'",
                  [request.golden_operation_fence_id, goldenId, expected.snapshotId, expected.sandboxId],
                )
              ).rows[0];
              if (!fence) unavailable("environment_admission_unavailable");
              fenceConsumed = true;
              return releaseFence;
            },
          },
          credentials: {
            ...runtime.stores.credentials,
            resolve: async () =>
              runtime.stores.credentials.resolve(selection.a, def.harness, m.account.id, m.account.version),
          },
        },
        selection.a,
        {
          golden: m.golden.name,
          provider: m.golden.provider,
          harness: def.harness,
          model: def.model,
          reasoningEffort: def.reasoningEffort,
          connections: def.connections,
          skills: def.skills,
          ...(input.prompt === undefined ? {} : { prompt: input.prompt as string }),
          ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds as number }),
          ...(size === undefined ? {} : { size }),
          ...(input.repo === undefined ? {} : { repo: input.repo as string }),
        },
        {
          ...runtime.options,
          newId: () => request.sandbox_id,
          beforeFork: async (sandboxId) => {
            await revalidate(actor, org, m);
            await runtime.options?.beforeFork?.(sandboxId);
            await sql.query(
              "update public.template_launch_requests set state='allocating',updated_at=now() where id=$1",
              [request.id],
            );
            allocating = true;
          },
          beforeStart: async (p, s) => {
            await revalidate(actor, org, m);
            await runtime.options?.beforeStart?.(p, s);
            if (def.variables.length)
              await p.configureReadableVariables!({
                sandboxId: s.providerSandboxId,
                harness: def.harness,
                variables: m.variables,
              });
          },
        },
      );
      const output = {
        requestId: request.id,
        state: "succeeded",
        id: result.sandbox.id,
        provider: result.sandbox.provider,
        providerSandboxId: result.sandbox.providerSandboxId,
        promptId: result.promptId ?? null,
        conversationId: result.conversationId ?? null,
        status: result.sandbox.status,
        // Keep the admitted DB manifest immutable. The durable completed result
        // adds verified receipts from the launch, not caller-supplied pins.
        manifest: { ...m, skillReceipts: result.sandbox.skills ?? [] },
      };
      await sql.query(
        "update public.template_launch_requests set state='succeeded',result=$2::text::jsonb,updated_at=now() where id=$1",
        [request.id, JSON.stringify(output)],
      );
      return output;
    } catch (error) {
      // Before adoption no provider mutation is possible. After adoption launchSandbox
      // owns release (registered child/confirmed absence) vs retention (unknown fork).
      if (!fenceConsumed) await releaseFence();
      // Once dispatch might have occurred, no timeout/exception proves absence. Never resend.
      const state = allocating ? "reconciling" : "failed";
      const safeReason = refusalReason(error) ?? (allocating ? "allocation_or_start_unknown" : "launch_unavailable");
      await sql.query("update public.template_launch_requests set state=$2,reason=$3,updated_at=now() where id=$1", [
        request.id,
        state,
        safeReason,
      ]);
      return { requestId: request.id, state, id: request.sandbox_id, reason: safeReason, manifest: m };
    }
  }
  function replay(row: RequestRow, bodyDigest: string): Record<string, unknown> {
    if (row.digest !== bodyDigest)
      throw new VaultError("conflict", "Request key already used with a different request.");
    return (
      row.result ?? {
        requestId: row.id,
        state: row.state,
        id: row.sandbox_id,
        reason: row.reason,
        manifest: row.manifest,
      }
    );
  }
  async function revalidate(actor: ApplicationVaultActor, org: string, m: Manifest) {
    await transaction(async (tx) => {
      const a = await member(tx, actor, org);
      const h = await header(tx, a, m.templateId);
      if ((await epoch(tx, a)) !== m.actorEpoch) unavailable("authorization_changed");
      await references(tx, a, h.scope, { ...m.definition, modelAccount: m.account }, false, m.connections);
    });
  }
  /** Later turns need current sandbox authority, NOT the mutable sources of a frozen readable launch. */
  async function prepare(
    provider: Provider,
    providerSandboxId: string,
    actor: { userId: string; orgId: string },
    requestId: string,
  ) {
    const row = (
      await sql.query<{ manifest: Manifest }>(
        `select r.manifest from public.template_launch_requests r join public.sandboxes s on s.id=r.sandbox_id
       join public.members m on m.org_id=s.org_id and m.user_id=$4
       where r.id=$5 and s.provider=$1 and s.provider_sandbox_id=$2 and r.org_id=$3
       and s.deleted_at is null and (s.owner_id=$4 or m.role='admin')`,
        [provider.id, providerSandboxId, actor.orgId, actor.userId, requestId],
      )
    ).rows[0];
    if (!row) throw new VaultError("forbidden", "Sandbox access denied.");
    const m = row.manifest;
    if (!Object.keys(m.variables).length) return;
    if (!provider.configureReadableVariables) unavailable("variable_delivery_unavailable");
    await provider.configureReadableVariables({
      sandboxId: providerSandboxId,
      harness: m.definition.harness,
      variables: m.variables,
    });
  }
  return { command, prepare };
}
export type TemplateService = ReturnType<typeof createTemplateService>;
