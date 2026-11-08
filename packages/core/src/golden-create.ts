import type { GitHubInstallationApp, GitHubResolveDeps } from "./github.ts";
import { resolveGitHubAccess } from "./github.ts";
import type { GoldenActor } from "./golden.ts";
import type { GoldenConfig, GoldenRepo } from "./golden-config.ts";
import { GoldenError } from "./golden-config.ts";
import { type GoldenCreateDeps, GoldenCreateService } from "./golden-create-service.ts";
import { goldenGitHubAdapter } from "./golden-github.ts";
import { scanGoldenSandbox } from "./golden-scan.ts";
import { createSqlGoldenStore, type Sql } from "./golden-store.ts";
import { sshStdinCheckout } from "./ssh-executor.ts";

export interface GoldenBackendSlot {
  reserve(input: {
    provider: string;
    backendId: string;
    capacity: number;
    orgId: string;
    ownerId: string;
  }): Promise<string>;
  reserveExisting(input: { provider: string; backendId: string; capacity: number; goldenId: string }): Promise<string>;
  finalize(reservationId: string, goldenId: string): Promise<void>;
  release(reservationId: string): Promise<void>;
}

export interface GoldenCreateOptions {
  /** The privileged database connection the server already holds (shared with the control API). */
  sql: Sql;
  /** How the caller's own cached OAuth access token (#492) is resolved for checkout; never an App token. */
  github: GitHubResolveDeps;
  /**
   * The GitHub App's server-only signing credentials, for an optional scoped, one-hour installation
   * token that is revoked right after checkout. Null (no `GITHUB_APP_PRIVATE_KEY`): checkout uses the
   * caller's own cached token instead, which is never rotated or revoked for a build.
   */
  installationApp: GitHubInstallationApp | null;
  /** GitHub REST calls (repos, installations, installation tokens). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** For tests: overrides the pinned SSH stdin transport, which otherwise spawns real `ssh-keygen`/`ssh`. */
  ssh?: GoldenCreateDeps["ssh"];
  /** Server-only global backend capacity. Omit for providers without a backend limit. */
  backendSlot?: GoldenBackendSlot;
  /** Boat is the secure-create default: one logical golden per backend account. */
  defaultProviderCapacity?: number;
}

/**
 * Wires `GoldenCreateService` to the real server: the caller's own cached OAuth token resolves and
 * authorizes the requested repos; checkout uses that token, or a scoped installation token when the
 * App is configured; the pinned SSH stdin transport clones over it; a fail-closed secret scan runs
 * before the snapshot; and only a ready snapshot is persisted, with org/private row level security.
 */
export function createGoldenCreateService(options: GoldenCreateOptions): GoldenCreateService {
  const adapter = goldenGitHubAdapter({
    app: options.installationApp,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    async accessToken(actor: GoldenActor) {
      const access = await resolveGitHubAccess(options.github, actor.userId);
      if (access.status !== "connected") throw new GoldenError("forbidden", access.message);
      return access.token;
    },
  });
  const slots: GoldenBackendSlot = options.backendSlot ?? sqlGoldenBackendSlots(options.sql);
  const deps: GoldenCreateDeps = {
    authorize: adapter.authorize,
    ssh: options.ssh ?? ((provider, input) => sshStdinCheckout(provider, input)),
    scan: (provider, sandboxId) => scanGoldenSandbox(provider, sandboxId),
    async reserve(provider, actor, existingGolden) {
      const capacity =
        provider.maxGoldens ?? options.defaultProviderCapacity ?? (provider.id === "boat" ? 1 : undefined);
      if (capacity === undefined) return undefined;
      if (!Number.isInteger(capacity) || capacity < 1)
        throw new GoldenError("invalid_config", "Provider golden capacity must be a positive integer.");
      if (!provider.backendIdentity)
        throw new GoldenError("forbidden", "Provider cannot verify its backend identity for golden capacity.");
      const identity = await provider.backendIdentity();
      if (!identity?.id)
        throw new GoldenError("forbidden", "Provider returned no backend identity for golden capacity.");
      if (existingGolden)
        return slots.reserveExisting({
          provider: provider.id,
          backendId: identity.id,
          capacity,
          goldenId: existingGolden.id,
        });
      return slots.reserve({
        provider: provider.id,
        backendId: identity.id,
        capacity,
        orgId: actor.orgId,
        ownerId: actor.userId,
      });
    },
    async release(reservationId) {
      await slots.release(reservationId);
    },
    async persist({ actor, existingGolden, name, visibility, repos, init, snapshot, builderId, reservationId }) {
      const config: GoldenConfig = {
        repos: repos.map(
          (repo): GoldenRepo => ({
            url: `https://github.com/${repo.owner}/${repo.repo}.git`,
            branch: repo.branch ?? "main",
            dir: repo.dir,
          }),
        ),
        init,
      };
      const persist = async (sql: Sql) => {
        const transactionalStore = createSqlGoldenStore(sql);
        const inserted = existingGolden
          ? existingGolden
          : await transactionalStore.insert({
              orgId: actor.orgId,
              name,
              visibility,
              ownerId: actor.userId,
              provider: "boat",
              modal: null,
              config,
            });
        if (existingGolden) await transactionalStore.setConfig(inserted.id, config);
        await transactionalStore.setSandbox(inserted.id, builderId);
        await transactionalStore.setSnapshot(inserted.id, snapshot);
        // This update is inside the same database transaction as the golden metadata. A failed
        // finalize rolls everything back; the service can safely release only the still-pending slot.
        if (reservationId)
          await sql.query("select public.finalize_golden_backend_slot($1::uuid, $2::uuid)", [
            reservationId,
            inserted.id,
          ]);
        return inserted.id;
      };
      return options.sql.transaction ? await options.sql.transaction(persist) : await persist(options.sql);
    },
  };
  if (adapter.mint) deps.mint = adapter.mint;
  return new GoldenCreateService(deps);
}

/** Service-role wrapper around the database reservation functions. */
export function sqlGoldenBackendSlots(sql: Sql): GoldenBackendSlot {
  return {
    async reserve(input) {
      const result = await sql.query<{ reserve_golden_backend_slot: string }>(
        "select public.reserve_golden_backend_slot($1, $2, $3, $4::uuid, $5::uuid)",
        [input.provider, input.backendId, input.capacity, input.orgId, input.ownerId],
      );
      const id = result.rows[0]?.reserve_golden_backend_slot;
      if (!id) throw new GoldenError("conflict", "This backend has reached its golden capacity.");
      return id;
    },
    async reserveExisting(input) {
      const result = await sql.query<{ reserve_existing_golden_backend_slot: string }>(
        "select public.reserve_existing_golden_backend_slot($1, $2, $3, $4::uuid)",
        [input.provider, input.backendId, input.capacity, input.goldenId],
      );
      const id = result.rows[0]?.reserve_existing_golden_backend_slot;
      if (!id) throw new GoldenError("conflict", "This backend has reached its golden capacity.");
      return id;
    },
    async finalize(reservationId, goldenId) {
      await sql.query("select public.finalize_golden_backend_slot($1::uuid, $2::uuid)", [reservationId, goldenId]);
    },
    async release(reservationId) {
      await sql.query("select public.release_golden_backend_slot($1::uuid)", [reservationId]);
    },
  };
}
