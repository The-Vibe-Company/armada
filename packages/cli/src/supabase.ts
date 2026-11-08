import {
  type GoldenActor,
  type GoldenConfig,
  GoldenError,
  type GoldenRecord,
  type GoldenStore,
  parseGoldenConfig,
  type Visibility,
} from "@armada/core";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MemberRow {
  org_id: string;
  role: string;
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

export interface SupabaseSession {
  store: GoldenStore;
  actor: GoldenActor;
}

/**
 * Goldens over Supabase PostgREST, as the signed-in user. The anon key identifies the project.
 * The access token is the user JWT, so row level security applies. No service role key is read.
 */
export async function openSupabaseGoldens(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<SupabaseSession> {
  const url = required(env, "ARMADA_SUPABASE_URL").replace(/\/$/, "");
  const anonKey = required(env, "ARMADA_SUPABASE_ANON_KEY");
  const accessToken = required(env, "ARMADA_ACCESS_TOKEN");
  const userId = jwtSubject(accessToken);
  const requestedOrg = env.ARMADA_ORG;
  if (requestedOrg !== undefined && requestedOrg !== "" && !UUID.test(requestedOrg)) {
    throw new GoldenError("invalid_config", "ARMADA_ORG must be an org id.");
  }
  const members = await rest<MemberRow[]>(fetchImpl, url, anonKey, accessToken, "members", {
    method: "GET",
    query: {
      select: "org_id,role",
      user_id: eq(userId),
      ...(requestedOrg ? { org_id: eq(requestedOrg) } : {}),
    },
  });
  const member = chooseMember(members, requestedOrg !== undefined && requestedOrg !== "");
  if (member.role !== "admin" && member.role !== "member") {
    throw new GoldenError("forbidden", "Your membership role is not one Armada knows.");
  }
  const actor: GoldenActor = { userId, orgId: member.org_id, role: member.role };
  const store = supabaseStore(fetchImpl, url, anonKey, accessToken);
  return { actor, store };
}

function chooseMember(members: MemberRow[], orgWasSet: boolean): MemberRow {
  const member = members[0];
  if (members.length === 1 && member) return member;
  if (members.length === 0) {
    throw new GoldenError(
      "forbidden",
      orgWasSet ? "You are not a member of that org." : "You are not a member of an org.",
    );
  }
  throw new GoldenError("invalid_config", `Set ARMADA_ORG. You belong to ${members.length} orgs.`);
}

function supabaseStore(fetchImpl: typeof fetch, url: string, anonKey: string, accessToken: string): GoldenStore {
  const call = <T>(table: string, init: RestInit) => rest<T>(fetchImpl, url, anonKey, accessToken, table, init);

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

async function rest<T>(
  fetchImpl: typeof fetch,
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
  if (!response.ok) throw httpError(response.status, body);
  return body as T;
}

function httpError(status: number, body: unknown): GoldenError {
  const message = isRecord(body) && typeof body.message === "string" ? body.message : "";
  const code = isRecord(body) && typeof body.code === "string" ? body.code : "";
  if (status === 401) return new GoldenError("forbidden", "The Supabase session was refused.");
  if (message.includes("must not contain secrets")) {
    return new GoldenError("invalid_config", "Golden config must not contain secrets.");
  }
  if (code === "23505" || message.includes("goldens_org_name_key") || message.includes("goldens_private_name_key")) {
    return new GoldenError("conflict", "A golden with this name already exists.");
  }
  if (status === 403 || message.includes("row-level security")) {
    return new GoldenError("forbidden", "You cannot change this golden.");
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

function jwtSubject(token: string): string {
  const part = token.split(".")[1];
  if (!part) throw new GoldenError("invalid_config", "ARMADA_ACCESS_TOKEN is not a JWT.");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new GoldenError("invalid_config", "ARMADA_ACCESS_TOKEN is not a JWT.");
  }
  if (!isRecord(payload) || typeof payload.sub !== "string" || !UUID.test(payload.sub)) {
    throw new GoldenError("invalid_config", "ARMADA_ACCESS_TOKEN has no user id.");
  }
  return payload.sub;
}

function eq(value: string): string {
  if (/^[A-Za-z0-9_.-]+$/.test(value)) return `eq.${value}`;
  return `eq."${value.replaceAll('"', '""')}"`;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new GoldenError("invalid_config", `Set ${name}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
