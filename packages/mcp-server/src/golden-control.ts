import { goldenForSettings, goldenResponse, parseMachineSizePolicy, providerRateLimitDetails } from "@armada/core";
import {
  addGoldenRepositories,
  assertGoldenMutation,
  connectGolden,
  type GoldenActor,
  GoldenError,
  type GoldenRecord,
  isSandboxProvider,
  normalizeGitHubGoldenConfig,
  type Provider,
  ProviderError,
  ProviderRoutingError,
  parseSnapshotConfig,
  resolveBoatKey,
  resolveOrg,
  retainFailureDiagnostic,
  scanGoldenSandbox,
  snapshotGolden,
  VaultError,
  type Visibility,
} from "@armada/core/server";
import type { Caller } from "./caller.ts";
import type { ControlOptions } from "./control.ts";
import { scopedOrg, selectedCaller } from "./control-caller.ts";
import { optional, required, UUID } from "./control-input.ts";
import { GOLDEN_ADOPTION_REQUEST } from "./golden-rest-schemas.ts";
import { launchActor } from "./launch-control.ts";
import { measureRequestPhase } from "./request-timing.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";
import { ToolApiError } from "./tool-api.ts";
import { describeToolFailure } from "./tool-failure.ts";

type ProviderControlOptions = Pick<ControlOptions, "providers" | "providerFor" | "store" | "encryptionKey">;
type GoldenControlOptions = ProviderControlOptions &
  Pick<ControlOptions, "goldenBuilds" | "goldenTarget" | "data" | "launch" | "listGoldenRecords">;

export async function listGoldens(
  options: GoldenControlOptions,
  caller: Caller,
  ref?: string,
): Promise<{ goldens: GoldenJson[] }> {
  if (options.listGoldenRecords) return { goldens: (await options.listGoldenRecords(caller, ref)).map(goldenJson) };
  if (!options.data) throw new VaultError("unavailable", "Golden listing is not configured on this server.");
  const data = options.data(caller);
  const goldens = (await Promise.all(caller.orgs.map(({ orgId }) => data.goldens.list(orgId)))).flat();
  return { goldens: goldens.map(goldenJson) };
}

export type GoldenJson = ReturnType<typeof goldenResponse> & { buildWarnings: string[] };

function goldenJson(row: GoldenRecord): GoldenJson {
  return { ...goldenResponse(row), buildWarnings: row.buildWarnings ?? [] };
}

/**
 * `armada golden create --name`: securely builds a golden from one or more GitHub repositories in a
 * disposable, no-env builder, over the caller's own cached GitHub connection, and persists it only
 * once a fail-closed secret scan and the snapshot both succeed. The caller needs no boat.dev key.
 */
async function createGoldenRoute(options: GoldenControlOptions, caller: Caller, body: Record<string, unknown>) {
  if (!options.goldenBuilds || (!options.providers && !options.providerFor)) {
    throw new VaultError("unavailable", "Secure golden creation is not configured on this server.");
  }
  required(body, "idempotencyKey");
  const org = await resolveOrg(options.store, caller.userId, scopedOrg(caller, optional(body, "org")));
  const visibility: Visibility = requiredBoolean(body, "private", false) ? "private" : "org";
  if (body.provider !== undefined && !isSandboxProvider(body.provider))
    throw new VaultError("invalid", "Provider is boat or modal.");
  if (visibility === "org" && org.role !== "admin")
    throw new VaultError("forbidden", "Only an admin can create an org golden.");
  const targetInput = { orgId: org.id, visibility, provider: (body.provider ?? "boat") as "boat" | "modal" };
  const target = options.goldenTarget
    ? await options.goldenTarget(targetInput, caller)
    : { ...targetInput, modal: null };
  if (target.provider === "modal" && !target.modal)
    throw new ProviderRoutingError("provider_routing_unavailable", "modal", "Modal is not configured.");
  const name = required(body, "name");
  const config = body.config === undefined ? undefined : normalizeGitHubGoldenConfig(parseSnapshotConfig(body.config));
  const repos = config ? [] : requiredRepos(body);
  const setup = optional(body, "setup");
  const actor: GoldenActor = { userId: caller.userId, orgId: org.id, role: org.role };
  assertGoldenMutation(actor, { orgId: org.id, visibility, ownerId: caller.userId, name });
  if (target.provider === "modal" && !options.providers)
    throw new ProviderRoutingError(
      "provider_routing_unavailable",
      "modal",
      "Modal resource routing is not configured.",
    );
  const provider = options.providers
    ? await options.providers.resolve(target, caller)
    : options.providerFor!(
        (
          await resolveBoatKey(options.store, options.encryptionKey, {
            userId: caller.userId,
            orgId: org.id,
            visibility,
          })
        ).key,
        { userId: caller.userId, orgId: org.id },
      );
  return options.goldenBuilds.admit(
    provider,
    actor,
    {
      ...(target.modal ? { modal: target.modal } : {}),
      name,
      visibility,
      repos,
      ...(config === undefined ? {} : { config }),
      ...(setup !== undefined ? { setup } : {}),
    },
    required(body, "idempotencyKey"),
  );
}

/** Rebuild an existing visible golden in place. The row, owner and visibility come from storage, never the body. */
async function updateGoldenRoute(
  options: GoldenControlOptions,
  caller: Caller,
  body: Record<string, unknown>,
  additive = false,
) {
  if (!options.goldenBuilds || (!options.providers && !options.providerFor) || !options.data)
    throw new VaultError("unavailable", "Secure golden creation is not configured on this server.");
  required(body, "idempotencyKey");
  const org = await resolveOrg(options.store, caller.userId, scopedOrg(caller, optional(body, "org")));
  const name = required(body, "name");
  const rows = await options.data(caller).goldens.findByName(org.id, name);
  const existingGolden = selectGolden(rows, body);
  if (!existingGolden) throw new GoldenError("not_found", `No golden named '${name}'.`);
  const actor: GoldenActor = { userId: caller.userId, orgId: org.id, role: org.role };
  assertGoldenMutation(actor, existingGolden);
  if (additive && (body.config !== undefined || body.setup !== undefined))
    throw new VaultError(
      "invalid",
      "--add-repo cannot replace config or setup. Use --config with the complete desired configuration for replacement.",
    );
  if (!additive && body.addRepos !== undefined)
    throw new VaultError(
      "invalid",
      "Additive repository updates require the golden/update-add-repos route. Upgrade the CLI; do not retry as a replacement.",
    );
  if (!additive && body.config === undefined) throw new VaultError("invalid", "config is required.");
  if (additive && (!Array.isArray(body.addRepos) || !body.addRepos.every((repo) => typeof repo === "string")))
    throw new VaultError("invalid", "addRepos must be a non-empty list of repository URLs.");
  const additions = additive ? (body.addRepos as string[]) : undefined;
  const config = normalizeGitHubGoldenConfig(
    additions ? addGoldenRepositories(existingGolden.config, additions, "snapshot") : parseSnapshotConfig(body.config),
  );
  const provider = await providerForGolden(options, caller, existingGolden);
  return options.goldenBuilds.admit(
    provider,
    actor,
    {
      name: existingGolden.name,
      visibility: existingGolden.visibility,
      repos: [],
      config,
      ...(optional(body, "setup") === undefined ? {} : { setup: optional(body, "setup")! }),
      existingGolden,
    },
    required(body, "idempotencyKey"),
    additions,
  );
}

async function snapshotGoldenRoute(
  options: GoldenControlOptions,
  caller: Caller,
  body: Record<string, unknown>,
): Promise<{ name: string; snapshot: string }> {
  if (!options.providerFor || !options.data)
    throw new VaultError("unavailable", "Golden snapshots are not configured on this server.");
  const org = await resolveOrg(options.store, caller.userId, scopedOrg(caller, optional(body, "org")));
  const name = required(body, "name");
  const data = options.data(caller);
  const rows = await data.goldens.findByName(org.id, name);
  const golden = selectGolden(rows, body);
  if (!golden) throw new GoldenError("not_found", `No golden named '${name}'.`);
  const actor: GoldenActor = { userId: caller.userId, orgId: org.id, role: org.role };
  assertGoldenMutation(actor, golden);
  const provider = await providerForGolden(options, caller, golden);
  await data.goldens.assertBackendBinding?.(golden, provider);
  const target = (await connectGolden(provider, data.goldens, actor, golden.name)).golden;
  if (!target.providerSandboxId) throw new GoldenError("conflict", `Golden '${target.name}' has no sandbox yet.`);
  await scanGoldenSandbox(provider, target.providerSandboxId, {
    repositories: target.config.repos.map((repo) => repo.dir),
  });
  const saved = await snapshotGolden(provider, data.goldens, actor, target.name, options.launch ?? {});
  return { name: saved.golden.name, snapshot: saved.snapshotName };
}

async function connectGoldenRoute(options: GoldenControlOptions, caller: Caller, body: Record<string, unknown>) {
  const org = await resolveOrg(options.store, caller.userId, scopedOrg(caller, optional(body, "org")));
  if (!options.providerFor) throw new VaultError("unavailable", "Golden connection is not configured on this server.");
  const name = required(body, "name");
  const data = options.data?.(caller);
  if (!data) throw new VaultError("unavailable", "Golden connection is not configured on this server.");
  const rows = await data.goldens.findByName(org.id, name);
  const golden = selectGolden(rows, body);
  if (!golden) throw new GoldenError("not_found", `No golden named '${name}'.`);
  const actor: GoldenActor = { userId: caller.userId, orgId: org.id, role: org.role };
  assertGoldenMutation(actor, golden);
  const provider = await providerForGolden(options, caller, golden);
  await data.goldens.assertBackendBinding?.(golden, provider);
  const connected = await connectGolden(provider, data.goldens, actor, name);
  return { golden: connected.golden.name, sandboxId: connected.sandbox.id, webUrl: null };
}

export async function providerForGolden(
  options: ProviderControlOptions,
  caller: Caller,
  golden: GoldenRecord & { sourceGoldenVisibility?: Visibility; runtimeTransport?: "dialout" },
): Promise<Provider> {
  if (options.providers) return options.providers.resolve(golden, caller);
  if (golden.provider !== "boat")
    throw new ProviderRoutingError("provider_routing_unavailable", "modal", "Modal is not configured.");
  const key = await resolveBoatKey(options.store, options.encryptionKey, {
    userId: caller.userId,
    orgId: golden.orgId,
    visibility: golden.sourceGoldenVisibility ?? golden.visibility,
  });
  return (
    options.providerFor?.(key.key, { userId: caller.userId, orgId: golden.orgId }) ??
    Promise.reject(new VaultError("unavailable", "Launching is not configured on this server."))
  );
}

function requiredRepos(body: Record<string, unknown>): string[] {
  const value = body.repos;
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item !== "")) {
    throw new VaultError("invalid", "repos must be a non-empty array of non-empty strings.");
  }
  return value;
}

function requiredBoolean(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new VaultError("invalid", `${key} must be a boolean.`);
  return value;
}

function selectGolden(rows: GoldenRecord[], body: Record<string, unknown>): GoldenRecord | undefined {
  const provider = optional(body, "provider");
  if (provider !== undefined && !isSandboxProvider(provider))
    throw new VaultError("invalid", "Provider is boat or modal.");
  const selected = rows.filter((row) => provider === undefined || row.provider === provider);
  if (selected.length > 1)
    throw new GoldenError("conflict", "Golden exists on boat and modal. Pass --provider boat or modal.");
  return selected[0];
}

async function retireGoldenSnapshots({ route, caller, body, options }: ControlRouteContext) {
  scopedOrg(caller, optional(body, "org"));
  if (!options.goldenRetirements) throw new VaultError("unavailable", "Snapshot retirement is not configured.");
  const id = required(body, "id");
  if (!UUID.test(id)) throw new VaultError("invalid", "id must be a golden UUID.");
  const selected = await selectedCaller(options, caller, optional(body, "org"));
  return options.goldenRetirements.forCaller(
    caller.userId,
    selected.orgs.map((o) => o.orgId),
    id,
    body.limit === undefined ? 20 : Number(body.limit),
    route.endsWith("reconcile"),
    body.receipts === undefined ? [] : (body.receipts as string[]),
  );
}

export const goldenRoutes = defineRoutes("golden", {
  "golden/capabilities": async ({ caller, body, options }) => {
    const selected = scopedOrg(caller, optional(body, "org"));
    const member =
      selected === undefined
        ? caller.orgs.length === 1
          ? caller.orgs[0]
          : undefined
        : caller.orgs.find((org) => org.orgId === selected);
    if (!member) throw new VaultError("forbidden", "Name an org in this caller's scope.");
    const backend = optional(body, "provider") ?? "boat";
    if (!isSandboxProvider(backend)) throw new VaultError("invalid", "Provider is boat or modal.");
    if (!options.providerMetadata)
      throw new VaultError("unavailable", "Read-only provider metadata is not configured.");
    return options.providerMetadata({ orgId: member.orgId, provider: backend }, caller);
  },
  "golden/adopt": async ({ caller, body, options }) => {
    if (!options.data || !options.providers) throw new VaultError("unavailable", "Sandbox control is not configured.");
    const org = optional(body, "org");
    const scoped = await selectedCaller(options, caller, org);
    const input = GOLDEN_ADOPTION_REQUEST.safeParse({ ...body, org });
    if (!input.success) {
      const details = input.error.issues.map((issue) => `${issue.message} at ${issue.path.join(".")}`).join("\n");
      throw new ToolApiError(
        "internal",
        `MCP error -32602: Input validation error: Invalid arguments for tool golden_adopt: ${details}`,
      );
    }
    if (!options.goldenAdoption) throw new ToolApiError("unsupported", "Canonical adoption is not configured.");
    const data = options.data(scoped);
    try {
      for (const { orgId, role } of scoped.orgs) {
        const golden = (await data.goldens.list(orgId)).find((row) => row.id === input.data.id);
        if (!golden) continue;
        const actor = { userId: scoped.userId, orgId, role };
        assertGoldenMutation(actor, golden);
        const providers = options.providers;
        const provider = await measureRequestPhase(options.timing, "provider", () => providers.resolve(golden, scoped));
        return await options.goldenAdoption(provider, actor, golden, input.data.confirmation);
      }
      throw new GoldenError("not_found", "Canonical adoption unavailable.");
    } catch (error) {
      const { code, message } = describeToolFailure(error);
      const details =
        error instanceof ProviderError && code === "rate_limited"
          ? providerRateLimitDetails({ ...error.details, retryAfterSeconds: error.retryAfterSeconds })
          : undefined;
      throw retainFailureDiagnostic(new ToolApiError(code, message, details), error);
    }
  },
  // The former switch cases checked token org scope before any route-specific validation.
  "golden/size-policy": async ({ caller, body, options }) => {
    scopedOrg(caller, optional(body, "org"));
    if (!options.data) throw new VaultError("unavailable", "Golden policies are not configured.");
    const data = options.data(caller);
    const name = required(body, "golden");
    const actor = await launchActor(data, caller, name, optional(body, "org"), options.store);
    const golden = await goldenForSettings(
      data.goldens,
      actor,
      name,
      optional(body, "provider") as "boat" | "modal" | undefined,
    );
    if (body.policy !== undefined) {
      const policy = parseMachineSizePolicy(
        body.policy,
        golden.config.repos.map((r) => r.dir),
      );
      if (!data.goldens.setSizePolicy) throw new VaultError("unavailable", "Policy writes are unavailable.");
      await data.goldens.setSizePolicy(golden, actor, policy);
      return { goldenId: golden.id, provider: golden.provider, repositories: golden.config.repos, policy };
    }
    return {
      goldenId: golden.id,
      provider: golden.provider,
      repositories: golden.config.repos,
      policy: golden.sizePolicy ?? null,
    };
  },
  "golden/retirement/dry-run": retireGoldenSnapshots,
  "golden/retirement/reconcile": retireGoldenSnapshots,
  "golden/remove": async ({ caller, body, options }) => {
    scopedOrg(caller, optional(body, "org"));
    const scopedCaller = await selectedCaller(options, caller, optional(body, "org"));
    const data = options.data?.(scopedCaller);
    if (!data?.removeGolden) throw new VaultError("unavailable", "Golden removal is not configured.");
    return data.removeGolden(required(body, "id"));
  },
  "golden/visibility": async ({ caller, body, options }) => {
    scopedOrg(caller, optional(body, "org"));
    const visibility = required(body, "visibility");
    if (visibility !== "org" && visibility !== "private")
      throw new VaultError("invalid", "Visibility is private or org.");
    const scopedCaller = await selectedCaller(options, caller, optional(body, "org"));
    const data = options.data?.(scopedCaller);
    if (!data?.setGoldenVisibility) throw new VaultError("unavailable", "Visibility management is not configured.");
    await data.setGoldenVisibility(required(body, "id"), visibility);
    return { ok: true };
  },
  "golden/list": async ({ caller, body, options }) => {
    scopedOrg(caller, optional(body, "org"));
    return options.listGoldenRecords
      ? listGoldens(options, caller, optional(body, "org"))
      : listGoldens(options, await selectedCaller(options, caller, optional(body, "org")));
  },
  "golden/build/find": async ({ caller, body, options }) => {
    scopedOrg(caller, optional(body, "org"));
    if (!options.goldenBuilds || !options.data)
      throw new VaultError("unavailable", "Durable golden builds are not configured.");
    const scoped = await selectedCaller(options, caller, optional(body, "org"));
    const org = await resolveOrg(options.store, caller.userId, scopedOrg(scoped, optional(body, "org")));
    const golden = selectGolden(await options.data(scoped).goldens.findByName(org.id, required(body, "name")), body);
    if (!golden)
      throw new GoldenError(
        "not_found",
        "No visible golden has that name and provider. Check golden list in the intended organization.",
      );
    return { build: await options.goldenBuilds.findActive(caller.userId, golden.id, [org.id]) };
  },
  "golden/build/cancel": async ({ caller, body, options }) => {
    scopedOrg(caller, optional(body, "org"));
    if (!options.goldenBuilds) throw new VaultError("unavailable", "Durable golden builds are not configured.");
    const scoped = await selectedCaller(options, caller, optional(body, "org"));
    return options.goldenBuilds.cancel(
      caller.userId,
      required(body, "jobId"),
      scoped.orgs.map((org) => org.orgId),
    );
  },
  "golden/build/status": ({ caller, body, options }) => {
    const org = scopedOrg(caller, optional(body, "org"));
    if (!options.goldenBuilds) throw new VaultError("unavailable", "Durable golden builds are not configured.");
    return options.goldenBuilds.status(
      caller.userId,
      optional(body, "jobId") ?? "",
      optional(body, "idempotencyKey") ? org : undefined,
      optional(body, "idempotencyKey"),
      caller.orgs.map((org) => org.orgId),
    );
  },
  "golden/create": ({ caller, body, options }) => {
    scopedOrg(caller, optional(body, "org"));
    return createGoldenRoute(options, caller, body);
  },
  "golden/update": ({ caller, body, options }) => {
    scopedOrg(caller, optional(body, "org"));
    return updateGoldenRoute(options, caller, body);
  },
  "golden/update-add-repos": ({ caller, body, options }) => {
    scopedOrg(caller, optional(body, "org"));
    return updateGoldenRoute(options, caller, body, true);
  },
  "golden/snapshot": ({ caller, body, options }) => {
    scopedOrg(caller, optional(body, "org"));
    return snapshotGoldenRoute(options, caller, body);
  },
  "golden/connect": ({ caller, body, options }) => {
    scopedOrg(caller, optional(body, "org"));
    return connectGoldenRoute(options, caller, body);
  },
});
