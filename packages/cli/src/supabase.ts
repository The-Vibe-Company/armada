import { AuthError, type AuthFetch } from "@armada/auth";
import {
  type GoldenActor,
  type GoldenConfig,
  GoldenError,
  type GoldenRecord,
  type GoldenStore,
  mapSandboxRow,
  parseGoldenConfig,
  type SandboxPatch,
  type SandboxRecord,
  type SandboxRow,
  type SandboxStore,
  type Visibility,
} from "@armada/core";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MemberRow {
  org_id: string;
  role: string;
  orgs?: { name?: string } | null;
}

interface GoldenRow {
  id: string;
  org_id: string;
  name: string;
  visibility: string;
  owner_id: string;
  boat_snapshot_id: string | null;
  boat_sandbox_id: string | null;
  config: unknown;
  created_at: string;
}

interface RestInit {
  method: string;
  query?: Record<string, string>;
  prefer?: string;
  body?: unknown;
}

const SELECT = "id,org_id,name,visibility,owner_id,boat_snapshot_id,boat_sandbox_id,config,created_at";

const SANDBOX_SELECT =
  "id,boat_id,golden_id,org_id,owner_id,harness,status,conversation_ids,created_at,stopped_at,deleted_at";

export interface SupabaseSession {
  store: GoldenStore;
  sandboxes: SandboxStore;
  actor: GoldenActor;
}

/** The signed-in user: the session `armada login` saved. The anon key identifies the project. */
export interface Identity {
  supabaseUrl: string;
  anonKey: string;
  accessToken: string;
  userId: string;
  /** Refreshes the bearer once after a rejected read-only request. */
  refresh?: (rejectedAccessToken: string) => Promise<string>;
}

/**
 * Goldens over Supabase PostgREST, as the signed-in user. The access token is the user JWT, so row
 * level security applies. No service role key is read. `orgRef` is an org name or id; without it the
 * caller's only org is used.
 */
export async function openSupabaseGoldens(
  identity: Identity,
  orgRef: string | undefined,
  fetchImpl: AuthFetch,
): Promise<SupabaseSession> {
  const url = identity.supabaseUrl.replace(/\/$/, "");
  const { anonKey, accessToken, userId } = identity;
  const call = <T>(table: string, init: RestInit) =>
    authenticatedRest<T>(fetchImpl, url, anonKey, accessToken, table, init, identity.refresh);
  const members = await call<MemberRow[]>("members", {
    method: "GET",
    query: { select: "org_id,role,orgs(name)", user_id: eq(userId) },
  });
  const member = chooseMember(members, orgRef);
  if (member.role !== "admin" && member.role !== "member") {
    throw new GoldenError("forbidden", "Your membership role is not one Armada knows.");
  }
  const actor: GoldenActor = { userId, orgId: member.org_id, role: member.role };
  const store = supabaseStore(fetchImpl, url, anonKey, accessToken, identity.refresh);
  const sandboxes = supabaseSandboxes(fetchImpl, url, anonKey, accessToken, identity.refresh);
  return { actor, store, sandboxes };
}

function chooseMember(members: MemberRow[], orgRef: string | undefined): MemberRow {
  if (orgRef !== undefined && orgRef.trim() !== "") {
    const wanted = orgRef.trim().toLowerCase();
    const found = members.filter((member) =>
      UUID.test(wanted) ? member.org_id === wanted : (member.orgs?.name ?? "").trim().toLowerCase() === wanted,
    );
    const only = found[0];
    if (only && found.length === 1) return only;
    throw new GoldenError("forbidden", "You are not a member of that org.");
  }
  const member = members[0];
  if (members.length === 1 && member) return member;
  if (members.length === 0) throw new GoldenError("forbidden", "You are not a member of an org.");
  throw new GoldenError("invalid_config", `Name the org with --org. You belong to ${members.length} orgs.`);
}

function supabaseStore(
  fetchImpl: AuthFetch,
  url: string,
  anonKey: string,
  accessToken: string,
  refresh?: Identity["refresh"],
): GoldenStore {
  const call = <T>(table: string, init: RestInit) =>
    authenticatedRest<T>(fetchImpl, url, anonKey, accessToken, table, init, refresh);

  return {
    async list(orgId): Promise<GoldenRecord[]> {
      const rows = await call<GoldenRow[]>("goldens", {
        method: "GET",
        query: { select: SELECT, org_id: eq(orgId), order: "name.asc,visibility.asc" },
      });
      return rows.map(mapRow);
    },

    async findByName(orgId, name): Promise<GoldenRecord[]> {
      const rows = await call<GoldenRow[]>("goldens", {
        method: "GET",
        query: { select: SELECT, org_id: eq(orgId), name: eq(name), order: "visibility.asc" },
      });
      return rows.map(mapRow);
    },

    async insert(input): Promise<GoldenRecord> {
      const rows = await call<GoldenRow[]>("goldens", {
        method: "POST",
        prefer: "return=representation",
        body: {
          org_id: input.orgId,
          name: input.name,
          visibility: input.visibility,
          owner_id: input.ownerId,
          config: input.config,
        },
      });
      const row = rows[0];
      if (!row) throw new GoldenError("forbidden", "The golden could not be created.");
      return mapRow(row);
    },

    setConfig(id: string, config: GoldenConfig): Promise<void> {
      return patch(call, id, { config }, { boat_sandbox_id: "is.null" });
    },

    setSandbox(id: string, boatSandboxId: string): Promise<void> {
      return patch(call, id, { boat_sandbox_id: boatSandboxId }, { boat_sandbox_id: "is.null" });
    },

    setSnapshot(id: string, boatSnapshotId: string): Promise<void> {
      return patch(call, id, { boat_snapshot_id: boatSnapshotId }, {});
    },
  };
}

function supabaseSandboxes(
  fetchImpl: AuthFetch,
  url: string,
  anonKey: string,
  accessToken: string,
  refresh?: Identity["refresh"],
): SandboxStore {
  const call = <T>(init: RestInit) =>
    authenticatedRest<T>(fetchImpl, url, anonKey, accessToken, "sandboxes", init, refresh);

  return {
    async insert(input): Promise<SandboxRecord> {
      const rows = await call<SandboxRow[]>({
        method: "POST",
        prefer: "return=representation",
        query: { select: SANDBOX_SELECT },
        body: {
          id: input.id,
          boat_id: input.boatId,
          golden_id: input.goldenId,
          org_id: input.orgId,
          owner_id: input.ownerId,
          harness: input.harness,
          status: input.status,
        },
      });
      const row = rows[0];
      if (!row) throw new GoldenError("forbidden", "The sandbox could not be recorded.");
      return mapSandboxRow(row);
    },

    async update(id: string, patch: SandboxPatch): Promise<void> {
      const body: Record<string, unknown> = {};
      if (patch.status !== undefined) body.status = patch.status;
      if (patch.conversationIds !== undefined) body.conversation_ids = patch.conversationIds;
      if (patch.stoppedAt !== undefined) body.stopped_at = patch.stoppedAt;
      if (patch.deletedAt !== undefined) body.deleted_at = patch.deletedAt;
      if (Object.keys(body).length === 0) return;
      const rows = await call<{ id: string }[]>({
        method: "PATCH",
        prefer: "return=representation",
        query: { id: eq(id), select: "id" },
        body,
      });
      if (!rows[0]) throw new GoldenError("forbidden", "The sandbox could not be updated.");
    },

    async listBefore(cutoff: string): Promise<SandboxRecord[]> {
      const rows = await call<SandboxRow[]>({
        method: "GET",
        query: { select: SANDBOX_SELECT, created_at: `lt.${cutoff}`, status: "neq.deleted", order: "created_at.asc" },
      });
      return rows.map(mapSandboxRow);
    },
  };
}

async function patch(
  call: <T>(table: string, init: RestInit) => Promise<T>,
  id: string,
  body: Record<string, unknown>,
  extra: Record<string, string>,
): Promise<void> {
  const rows = await call<GoldenRow[]>("goldens", {
    method: "PATCH",
    prefer: "return=representation",
    query: { id: eq(id), ...extra },
    body,
  });
  if (!rows[0]) throw new GoldenError("forbidden", "The golden could not be updated.");
}

async function authenticatedRest<T>(
  fetchImpl: AuthFetch,
  url: string,
  anonKey: string,
  accessToken: string,
  table: string,
  init: RestInit,
  refresh?: Identity["refresh"],
): Promise<T> {
  try {
    return await rest<T>(fetchImpl, url, anonKey, accessToken, table, init);
  } catch (error) {
    if (!refresh || !(error instanceof AuthError) || error.code !== "unauthorized" || init.method !== "GET") {
      throw error;
    }
    const token = await refresh(accessToken);
    return rest<T>(fetchImpl, url, anonKey, token, table, init);
  }
}

async function rest<T>(
  fetchImpl: AuthFetch,
  base: string,
  anonKey: string,
  accessToken: string,
  table: string,
  init: RestInit,
): Promise<T> {
  const url = new URL(`${base}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method,
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.prefer ? { prefer: init.prefer } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new GoldenError("forbidden", "The Supabase request failed.");
  }
  const text = await response.text();
  let body: unknown = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      throw new GoldenError("forbidden", `Supabase answered ${response.status}.`);
    }
  }
  if (!response.ok) throw httpError(response.status, body, table);
  return body as T;
}

function httpError(status: number, body: unknown, table: string): GoldenError | AuthError {
  const message = isRecord(body) && typeof body.message === "string" ? body.message : "";
  const code = isRecord(body) && typeof body.code === "string" ? body.code : "";
  if (status === 401) return new AuthError("Run armada login.", "unauthorized");
  if (message.includes("must not contain secrets")) {
    return new GoldenError("invalid_config", "Golden config must not contain secrets.");
  }
  if (code === "23505" || message.includes("goldens_org_name_key") || message.includes("goldens_private_name_key")) {
    return new GoldenError("conflict", "A golden with this name already exists.");
  }
  if (status === 403 || message.includes("row-level security")) {
    return new GoldenError(
      "forbidden",
      table === "sandboxes" ? "You cannot launch or change this sandbox." : "You cannot change this golden.",
    );
  }
  return new GoldenError("forbidden", "The Supabase request failed.");
}

function mapRow(row: GoldenRow): GoldenRecord {
  if (row.visibility !== "org" && row.visibility !== "private") {
    throw new GoldenError("forbidden", "A golden row has an unknown visibility.");
  }
  const visibility: Visibility = row.visibility === "private" ? "private" : "org";
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    visibility,
    ownerId: row.owner_id,
    boatSnapshotId: row.boat_snapshot_id,
    boatSandboxId: row.boat_sandbox_id,
    config: parseGoldenConfig(row.config),
    createdAt: row.created_at,
  };
}

function eq(value: string): string {
  if (/^[A-Za-z0-9_.-]+$/.test(value)) return `eq.${value}`;
  return `eq."${value.replaceAll('"', '""')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
