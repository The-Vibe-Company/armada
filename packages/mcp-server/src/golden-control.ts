import { goldenResponse } from "@armada/core";
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
  ProviderRoutingError,
  parseGoldenConfig,
  resolveBoatKey,
  resolveOrg,
  scanGoldenSandbox,
  snapshotGolden,
  VaultError,
  type Visibility,
} from "@armada/core/server";
import type { Caller } from "./caller.ts";
import type { ControlOptions } from "./control.ts";
import { scopedOrg } from "./control-caller.ts";
import { optional, required } from "./control-input.ts";

type ProviderControlOptions = Pick<ControlOptions, "providers" | "providerFor" | "store" | "encryptionKey">;
type GoldenControlOptions = ProviderControlOptions &
  Pick<ControlOptions, "goldenBuilds" | "goldenTarget" | "data" | "launch">;

/** The same visibility-filtered representation returned by MCP golden_list. */
export async function listGoldens(options: GoldenControlOptions, caller: Caller): Promise<{ goldens: GoldenJson[] }> {
  if (!options.data) throw new VaultError("unavailable", "Golden listing is not configured on this server.");
  const data = options.data(caller);
  const goldens = [];
  for (const { orgId } of caller.orgs) goldens.push(...(await data.goldens.list(orgId)));
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
export async function createGoldenRoute(options: GoldenControlOptions, caller: Caller, body: Record<string, unknown>) {
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
    throw new ProviderRoutingError("provider_not_configured", "modal", "Modal is not configured.");
  const name = required(body, "name");
  const config = body.config === undefined ? undefined : normalizeGitHubGoldenConfig(parseGoldenConfig(body.config));
  const repos = config ? [] : requiredRepos(body);
  const setup = optional(body, "setup");
  const actor: GoldenActor = { userId: caller.userId, orgId: org.id, role: org.role };
  assertGoldenMutation(actor, { orgId: org.id, visibility, ownerId: caller.userId, name });
  if (target.provider === "modal" && !options.providers)
    throw new ProviderRoutingError("provider_not_configured", "modal", "Modal resource routing is not configured.");
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
export async function updateGoldenRoute(
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
  const config = normalizeGitHubGoldenConfig(
    additive ? addGoldenRepositories(existingGolden.config, body.addRepos as string[]) : parseGoldenConfig(body.config),
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
  );
}

export async function snapshotGoldenRoute(
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

export async function connectGoldenRoute(options: GoldenControlOptions, caller: Caller, body: Record<string, unknown>) {
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
    throw new ProviderRoutingError("provider_not_configured", "modal", "Modal is not configured.");
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

export function selectGolden(rows: GoldenRecord[], body: Record<string, unknown>): GoldenRecord | undefined {
  const provider = optional(body, "provider");
  if (provider !== undefined && !isSandboxProvider(provider))
    throw new VaultError("invalid", "Provider is boat or modal.");
  const selected = rows.filter((row) => provider === undefined || row.provider === provider);
  if (selected.length > 1)
    throw new GoldenError("conflict", "Golden exists on boat and modal. Pass --provider boat or modal.");
  return selected[0];
}
