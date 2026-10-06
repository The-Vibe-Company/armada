// The app's one database: Postgres (Neon in production, THE-849). Accounts,
// organizations, the vault, the workers and the fleet's live data (projects,
// events, runtime handles, worker profiles, the coordinators' inboxes, leases
// and coordinator presence) all live here, next to the app's functions.
//
// Everything reaches it through `Database`, the small part of node-postgres's
// pool the app uses, so the same code runs on Neon (`pg`) and, for tests and
// local development, on PGlite (Postgres in WebAssembly, `pglite:` URLs).
// Better Auth reaches it through Kysely with `PgDialect`. The schema comes from
// `DB_MIGRATIONS`, applied once each in order, never from Better Auth's
// automatic migration: a test checks the two agree.
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";

export type Row = Record<string, unknown>;

export interface Rows<R = Row> {
  rows: R[];
  /** Rows written by an INSERT, UPDATE or DELETE. */
  rowCount: number;
}

/** One statement with `$1`-style parameters. */
export interface Queryable {
  query<R = Row>(text: string, params?: readonly unknown[]): Promise<Rows<R>>;
}

/**
 * A connection taken from the pool: a transaction stays on it. Release it once
 * done; `destroy` after a failed statement, so a connection whose transaction
 * may still be open never serves another request.
 */
export interface Connection extends Queryable {
  release(destroy?: boolean): void;
}

export interface Database extends Queryable {
  connect(): Promise<Connection>;
  end(): Promise<void>;
}

/** Runs `work` in one transaction on one connection: committed when it returns, rolled back when it throws. */
export async function transaction<T>(db: Database, work: (tx: Queryable) => Promise<T>): Promise<T> {
  const conn = await db.connect();
  let failed = false;
  try {
    await conn.query("BEGIN");
    const result = await work(conn);
    await conn.query("COMMIT");
    return result;
  } catch (err) {
    failed = true;
    await conn.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    conn.release(failed);
  }
}

// ------------------------------------------------------------ values

/** A timestamp column as core's ISO string; null stays null. */
export function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(typeof v === "number" ? v : String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** A timestamp column that is never null. */
export const isoAt = (v: unknown): string => iso(v) ?? "";

export const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

// ------------------------------------------------------------ Kysely, for Better Auth

class PgConnection implements DatabaseConnection {
  /** A statement failed: the connection is not given back to the pool. */
  private failed = false;

  constructor(private readonly conn: Connection) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    try {
      const rs = await this.conn.query<R>(query.sql, query.parameters);
      return { rows: rs.rows, numAffectedRows: BigInt(rs.rowCount) };
    } catch (err) {
      this.failed = true;
      throw err;
    }
  }

  // biome-ignore lint/correctness/useYield: Better Auth never streams.
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("the app's database driver does not stream queries");
  }

  release() {
    this.conn.release(this.failed);
  }
}

class PgDriver implements Driver {
  constructor(private readonly db: Database) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return new PgConnection(await this.db.connect());
  }
  async beginTransaction(c: DatabaseConnection): Promise<void> {
    await c.executeQuery({ sql: "BEGIN", parameters: [] } as unknown as CompiledQuery);
  }
  async commitTransaction(c: DatabaseConnection): Promise<void> {
    await c.executeQuery({ sql: "COMMIT", parameters: [] } as unknown as CompiledQuery);
  }
  async rollbackTransaction(c: DatabaseConnection): Promise<void> {
    await c.executeQuery({ sql: "ROLLBACK", parameters: [] } as unknown as CompiledQuery);
  }
  async releaseConnection(c: DatabaseConnection): Promise<void> {
    (c as PgConnection).release();
  }
  // The pool belongs to whoever opened it (`openDatabase`).
  async destroy(): Promise<void> {}
}

/** Kysely over the app's database, on either driver. */
export class PgDialect implements Dialect {
  constructor(private readonly db: Database) {}
  createAdapter = () => new PostgresAdapter();
  createDriver = () => new PgDriver(this.db);
  createQueryCompiler = () => new PostgresQueryCompiler();
  createIntrospector = (db: Parameters<Dialect["createIntrospector"]>[0]) => new PostgresIntrospector(db);
}

// ------------------------------------------------------------ the schema

/**
 * The schema, one entry per version. Each version is applied once, in order,
 * in one transaction that first takes an advisory lock, so two servers
 * starting together apply it once. Never edit an applied version: add one.
 *
 * Version 1 is everything the app had before THE-849, moved to one Postgres
 * database:
 * - what Better Auth 1.7 needs for email and password, GitHub, organizations,
 *   database rate limiting, device authorization (`armada login`) and the
 *   organizations' API keys;
 * - the vault (THE-840): the organizations' sealed keys and their audit list;
 * - the workers (THE-841): one row per launch, its one-time launch token and
 *   the worker session it was exchanged for (both hashes only), and the
 *   exchange attempts the rate limit counts;
 * - the fleet: projects and the organization each belongs to, events, the
 *   runtime session holding each ticket and the profile its claim named, the
 *   coordinators' inboxes (a dashboard request's question or profile is on its
 *   item), leases, and when each project's coordinator last read its inbox.
 *   Partial unique indexes keep one open plan, hand-back, launch request per
 *   ticket and one open answer request per question, whatever the races.
 *
 * Version 2 links organizations to installations of the GitHub App (THE-851).
 * Versions 5 and 6 keep each project's reading of Linear and GitHub (THE-853).
 */
export const DB_MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      // ---------------------------------------------------------- Better Auth
      `CREATE TABLE IF NOT EXISTS "user" (
        "id" text NOT NULL PRIMARY KEY,
        "name" text NOT NULL,
        "email" text NOT NULL UNIQUE,
        "emailVerified" boolean NOT NULL,
        "image" text,
        "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS "session" (
        "id" text NOT NULL PRIMARY KEY,
        "expiresAt" timestamptz NOT NULL,
        "token" text NOT NULL UNIQUE,
        "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" timestamptz NOT NULL,
        "ipAddress" text,
        "userAgent" text,
        "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
        "activeOrganizationId" text
      )`,
      `CREATE TABLE IF NOT EXISTS "account" (
        "id" text NOT NULL PRIMARY KEY,
        "accountId" text NOT NULL,
        "providerId" text NOT NULL,
        "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
        "accessToken" text,
        "refreshToken" text,
        "idToken" text,
        "accessTokenExpiresAt" timestamptz,
        "refreshTokenExpiresAt" timestamptz,
        "scope" text,
        "password" text,
        "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" timestamptz NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS "verification" (
        "id" text NOT NULL PRIMARY KEY,
        "identifier" text NOT NULL,
        "value" text NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS "organization" (
        "id" text NOT NULL PRIMARY KEY,
        "name" text NOT NULL,
        "slug" text NOT NULL UNIQUE,
        "logo" text,
        "createdAt" timestamptz NOT NULL,
        "metadata" text
      )`,
      `CREATE TABLE IF NOT EXISTS "member" (
        "id" text NOT NULL PRIMARY KEY,
        "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
        "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
        "role" text NOT NULL,
        "createdAt" timestamptz NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS "invitation" (
        "id" text NOT NULL PRIMARY KEY,
        "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
        "email" text NOT NULL,
        "role" text,
        "status" text NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "inviterId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS "rateLimit" (
        "id" text NOT NULL PRIMARY KEY,
        "key" text NOT NULL UNIQUE,
        "count" integer NOT NULL,
        "lastRequest" bigint NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS "deviceCode" (
        "id" text NOT NULL PRIMARY KEY,
        "deviceCode" text NOT NULL,
        "userCode" text NOT NULL,
        "userId" text,
        "expiresAt" timestamptz NOT NULL,
        "status" text NOT NULL,
        "lastPolledAt" timestamptz,
        "pollingInterval" integer,
        "clientId" text,
        "scope" text
      )`,
      `CREATE TABLE IF NOT EXISTS "apikey" (
        "id" text NOT NULL PRIMARY KEY,
        "configId" text NOT NULL,
        "name" text,
        "start" text,
        "referenceId" text NOT NULL,
        "prefix" text,
        "key" text NOT NULL,
        "refillInterval" integer,
        "refillAmount" integer,
        "lastRefillAt" timestamptz,
        "enabled" boolean,
        "rateLimitEnabled" boolean,
        "rateLimitTimeWindow" integer,
        "rateLimitMax" integer,
        "requestCount" integer,
        "remaining" integer,
        "lastRequest" timestamptz,
        "expiresAt" timestamptz,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "permissions" text,
        "metadata" text
      )`,
      `CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId")`,
      `CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId")`,
      `CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier")`,
      `CREATE INDEX IF NOT EXISTS "member_organizationId_idx" ON "member" ("organizationId")`,
      `CREATE INDEX IF NOT EXISTS "member_userId_idx" ON "member" ("userId")`,
      `CREATE INDEX IF NOT EXISTS "invitation_organizationId_idx" ON "invitation" ("organizationId")`,
      `CREATE INDEX IF NOT EXISTS "invitation_email_idx" ON "invitation" ("email")`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "deviceCode_deviceCode_uidx" ON "deviceCode" ("deviceCode")`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "deviceCode_userCode_uidx" ON "deviceCode" ("userCode")`,
      `CREATE INDEX IF NOT EXISTS "apikey_configId_idx" ON "apikey" ("configId")`,
      `CREATE INDEX IF NOT EXISTS "apikey_referenceId_idx" ON "apikey" ("referenceId")`,
      `CREATE INDEX IF NOT EXISTS "apikey_key_idx" ON "apikey" ("key")`,

      // ---------------------------------------------------------- the vault
      `CREATE TABLE IF NOT EXISTS "armada_secret" (
        "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
        "userId" text NOT NULL DEFAULT '',
        "name" text NOT NULL,
        "sealed" text NOT NULL,
        "setById" text NOT NULL,
        "setByLabel" text NOT NULL,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        PRIMARY KEY ("organizationId", "userId", "name")
      )`,
      `CREATE TABLE IF NOT EXISTS "armada_secret_event" (
        "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "organizationId" text NOT NULL,
        "at" timestamptz NOT NULL,
        "action" text NOT NULL,
        "keys" text NOT NULL,
        "actorKind" text NOT NULL,
        "actorId" text NOT NULL,
        "actorLabel" text NOT NULL,
        "detail" text NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS "armada_secret_event_org_idx" ON "armada_secret_event" ("organizationId", "id")`,
      `CREATE INDEX IF NOT EXISTS "armada_secret_event_actor_idx" ON "armada_secret_event" ("actorKind", "actorId", "at")`,

      // ---------------------------------------------------------- the workers
      `CREATE TABLE IF NOT EXISTS "armada_worker" (
        "id" text NOT NULL PRIMARY KEY,
        "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
        "project" text NOT NULL,
        "ticket" text NOT NULL,
        "launchedByKind" text NOT NULL,
        "launchedById" text NOT NULL,
        "launchedByLabel" text NOT NULL,
        "createdAt" timestamptz NOT NULL,
        "tokenHash" text NOT NULL UNIQUE,
        "tokenExpiresAt" timestamptz NOT NULL,
        "tokenUsedAt" timestamptz,
        "sessionHash" text UNIQUE,
        "sessionExpiresAt" timestamptz,
        "sessionSeenAt" timestamptz,
        "endedAt" timestamptz,
        "endReason" text,
        "endedByLabel" text
      )`,
      `CREATE INDEX IF NOT EXISTS "armada_worker_org_idx" ON "armada_worker" ("organizationId", "createdAt")`,
      `CREATE INDEX IF NOT EXISTS "armada_worker_ticket_idx" ON "armada_worker" ("organizationId", "project", "ticket")`,
      `CREATE TABLE IF NOT EXISTS "armada_launch_attempt" (
        "address" text NOT NULL,
        "at" timestamptz NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS "armada_launch_attempt_idx" ON "armada_launch_attempt" ("address", "at")`,

      // ---------------------------------------------------------- the fleet
      // `organization_id` is null until the project is given to one (see `assignUnownedProjects`).
      `CREATE TABLE IF NOT EXISTS projects (
        slug text PRIMARY KEY,
        name text NOT NULL,
        repository text NOT NULL,
        program_root text NOT NULL,
        organization_id text REFERENCES "organization" ("id"),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        organization_assigned_at timestamptz
      )`,
      // kind: claim | report | release | merge.
      `CREATE TABLE IF NOT EXISTS events (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        project text NOT NULL,
        ticket text NOT NULL,
        kind text NOT NULL,
        phase text,
        message text,
        runtime text,
        handle text,
        pr_url text,
        head_sha text,
        created_at timestamptz NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS events_by_ticket ON events (project, ticket, created_at)",
      "CREATE INDEX IF NOT EXISTS events_by_time ON events (project, created_at)",
      `CREATE TABLE IF NOT EXISTS runtime_handles (
        project text NOT NULL,
        ticket text NOT NULL,
        runtime text NOT NULL,
        handle text NOT NULL,
        branch text,
        claimed_at timestamptz NOT NULL,
        released_at timestamptz,
        PRIMARY KEY (project, ticket)
      )`,
      `CREATE TABLE IF NOT EXISTS worker_profiles (
        project text NOT NULL,
        ticket text NOT NULL,
        profile text NOT NULL,
        agent text NOT NULL,
        model text NOT NULL,
        effort text NOT NULL,
        fast_mode boolean NOT NULL,
        routed text,
        reason text,
        why text NOT NULL,
        recorded_at timestamptz NOT NULL,
        PRIMARY KEY (project, ticket)
      )`,
      // kind: question | plan | request | hand-back | note | answer-request | launch-request.
      // request_question and request_profile: what a dashboard request is about.
      `CREATE TABLE IF NOT EXISTS inbox_items (
        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        project text NOT NULL,
        ticket text,
        kind text NOT NULL,
        recipient text NOT NULL,
        author text,
        body text NOT NULL,
        created_at timestamptz NOT NULL,
        resolved_at timestamptz,
        resolution text,
        request_question bigint REFERENCES inbox_items (id),
        request_profile text
      )`,
      "CREATE INDEX IF NOT EXISTS inbox_open ON inbox_items (project, recipient, resolved_at)",
      `CREATE UNIQUE INDEX IF NOT EXISTS inbox_one_open_per_ticket ON inbox_items (project, ticket, kind)
        WHERE resolved_at IS NULL AND kind IN ('plan', 'hand-back', 'launch-request')`,
      `CREATE UNIQUE INDEX IF NOT EXISTS inbox_one_open_answer ON inbox_items (project, request_question)
        WHERE resolved_at IS NULL AND kind = 'answer-request'`,
      `CREATE TABLE IF NOT EXISTS leases (
        project text NOT NULL,
        name text NOT NULL,
        holder text NOT NULL,
        acquired_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        PRIMARY KEY (project, name)
      )`,
      `CREATE TABLE IF NOT EXISTS coordinator_presence (
        project text PRIMARY KEY,
        handle text,
        seen_at timestamptz NOT NULL
      )`,
    ],
  },
  {
    // The installations of the Armada GitHub App an organization reads through
    // (THE-851), linked by an owner or admin who could reach them on GitHub.
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS "armada_github_installation" (
        "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
        "installationId" bigint NOT NULL,
        "account" text NOT NULL,
        "linkedById" text NOT NULL,
        "linkedByLabel" text NOT NULL,
        "linkedAt" timestamptz NOT NULL,
        PRIMARY KEY ("organizationId", "installationId")
      )`,
    ],
  },
  {
    // Terminals reach the fleet's data through the Armada API (THE-850): the
    // vault no longer keeps database access for them, so what it kept goes.
    version: 3,
    statements: [`DELETE FROM "armada_secret" WHERE "name" LIKE 'turso-%'`],
  },
  {
    // What the CLI's calls through the API read on every poll (THE-850): the
    // sessions holding a ticket, the answers since the oldest open claim, and
    // an organization's projects. Each stays an index lookup as history grows.
    version: 4,
    statements: [
      "CREATE INDEX IF NOT EXISTS runtime_handles_open ON runtime_handles (project) WHERE released_at IS NULL",
      `CREATE INDEX IF NOT EXISTS inbox_answered ON inbox_items (project, resolved_at)
        WHERE kind IN ('question', 'plan') AND resolved_at IS NOT NULL`,
      "CREATE INDEX IF NOT EXISTS projects_by_organization ON projects (organization_id)",
    ],
  },
  {
    // Each project's reading of Linear and GitHub (THE-853): pages and the
    // live route read it here and never call Linear or GitHub themselves.
    // `version` grows with each new reading, so a server keeps the body it
    // already has; the webhooks find a project by a Linear id it holds
    // (`issue_ids`) or by its repository, and leave marks (`*_dirty`,
    // `touched`) the next refresh takes over; `refreshing_until` is the lease
    // that keeps one refresh per project at a time across servers.
    version: 5,
    statements: [
      `CREATE TABLE IF NOT EXISTS fleet_snapshots (
        key text PRIMARY KEY,
        version bigint NOT NULL DEFAULT 0,
        body jsonb,
        repository text,
        issue_ids text[] NOT NULL DEFAULT '{}',
        started_at timestamptz,
        read_at timestamptz,
        full_at timestamptz,
        attempted_at timestamptz,
        error text,
        linear_dirty boolean NOT NULL DEFAULT false,
        forge_dirty boolean NOT NULL DEFAULT false,
        full_due boolean NOT NULL DEFAULT false,
        touched text[] NOT NULL DEFAULT '{}',
        refreshing_until timestamptz
      )`,
      "CREATE INDEX IF NOT EXISTS fleet_snapshots_issues ON fleet_snapshots USING gin (issue_ids)",
      "CREATE INDEX IF NOT EXISTS fleet_snapshots_repository ON fleet_snapshots (repository)",
    ],
  },
  {
    // The webhooks' marks stay until a reading that saw them is written
    // (`marked` counts them), and when each webhook last marked a reading
    // (THE-853).
    version: 6,
    statements: [
      `ALTER TABLE fleet_snapshots
        ADD COLUMN IF NOT EXISTS marked bigint NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS linear_hook_at timestamptz,
        ADD COLUMN IF NOT EXISTS github_hook_at timestamptz`,
    ],
  },
  {
    // Each project's keys and secrets (THE-859): a row of the vault belongs to
    // the organization (project '', every row so far) or to one project, and
    // so does an event of the audit list, which a project filters. Who
    // created each organization API key, so its rights are those its creator
    // still has.
    version: 7,
    statements: [
      `ALTER TABLE "armada_secret" ADD COLUMN IF NOT EXISTS "project" text NOT NULL DEFAULT ''`,
      `ALTER TABLE "armada_secret" DROP CONSTRAINT IF EXISTS "armada_secret_pkey"`,
      `ALTER TABLE "armada_secret" ADD PRIMARY KEY ("organizationId", "project", "userId", "name")`,
      `ALTER TABLE "armada_secret_event" ADD COLUMN IF NOT EXISTS "project" text NOT NULL DEFAULT ''`,
      `CREATE INDEX IF NOT EXISTS "armada_secret_event_project_idx" ON "armada_secret_event" ("organizationId", "project", "id")`,
      `CREATE TABLE IF NOT EXISTS "armada_api_key_creator" (
        "keyId" text NOT NULL PRIMARY KEY,
        "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
        "userId" text NOT NULL,
        "createdAt" timestamptz NOT NULL
      )`,
    ],
  },
  {
    // The version of the CLI each coordinator runs, from the header of its
    // inbox reads (THE-863): the dashboard shows a coordinator behind the latest.
    version: 8,
    statements: ["ALTER TABLE coordinator_presence ADD COLUMN IF NOT EXISTS cli_version text"],
  },
  {
    // A launch no claim followed shows as not started (THE-872): the
    // worker's runtime session as its sign-in named it, and a project's
    // launches of the last day, read on each inbox read.
    version: 9,
    statements: [
      `ALTER TABLE "armada_worker" ADD COLUMN IF NOT EXISTS "runtimeHandle" text`,
      `CREATE INDEX IF NOT EXISTS "armada_worker_project_idx" ON "armada_worker" ("project", "createdAt")`,
    ],
  },
  {
    version: 10,
    statements: [
      "ALTER TABLE projects ADD COLUMN owner text",
      "ALTER TABLE coordinator_presence ADD COLUMN harness text",
      "ALTER TABLE coordinator_presence ADD COLUMN model text",
      "ALTER TABLE coordinator_presence ADD COLUMN started_at timestamptz",
      "ALTER TABLE coordinator_presence ADD COLUMN inbox_seen_at timestamptz",
      "UPDATE coordinator_presence SET started_at = seen_at, inbox_seen_at = seen_at",
      "ALTER TABLE inbox_items ADD COLUMN request_pr bigint",
      "CREATE UNIQUE INDEX inbox_merge_request ON inbox_items (project, request_pr) WHERE resolved_at IS NULL AND kind = 'merge-request'",
      "CREATE UNIQUE INDEX inbox_release_request ON inbox_items (project, ticket) WHERE resolved_at IS NULL AND kind = 'release-request'",
      "CREATE UNIQUE INDEX inbox_plan_changes ON inbox_items (project, request_question) WHERE resolved_at IS NULL AND kind = 'plan-changes'",
      "CREATE INDEX events_inbox_history ON events (project, created_at, id) WHERE kind = 'inbox'",
      `CREATE TABLE fleet_sessions (
        project text NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
        ticket text NOT NULL, runtime text NOT NULL, handle text NOT NULL, branch text,
        claimed_at timestamptz NOT NULL, released_at timestamptz,
        profile text, agent text, model text, effort text,
        report_at timestamptz, report_message text, report_phase text,
        PRIMARY KEY (project, ticket, handle, claimed_at)
      )`,
      "CREATE INDEX fleet_sessions_history ON fleet_sessions (project, claimed_at)",
      `INSERT INTO fleet_sessions (project, ticket, runtime, handle, branch, claimed_at, released_at, profile, agent, model, effort)
       SELECT h.project, h.ticket, h.runtime, h.handle, h.branch, h.claimed_at, h.released_at, p.profile, p.agent, p.model, p.effort
       FROM runtime_handles h LEFT JOIN worker_profiles p ON p.project = h.project AND p.ticket = h.ticket`,
    ],
  },
  {
    // An agent's page reads its ticket's whole inbox history (THE-869).
    version: 11,
    statements: ["CREATE INDEX inbox_by_ticket ON inbox_items (project, ticket, created_at)"],
  },
  {
    version: 12,
    statements: [
      `CREATE TABLE attachments (
        id text PRIMARY KEY, project text NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
        ticket text NOT NULL, kind text NOT NULL CHECK (kind IN ('image', 'link')),
        bytes bytea, content_type text, size integer NOT NULL CHECK (size >= 0 AND size <= 2097152),
        sha256 text NOT NULL, caption text, author text NOT NULL, created_at timestamptz NOT NULL,
        reference text, url text, done_at timestamptz,
        CHECK ((kind = 'image' AND bytes IS NOT NULL AND content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif') AND url IS NULL AND octet_length(bytes) = size)
          OR (kind = 'link' AND bytes IS NULL AND content_type IS NULL AND url IS NOT NULL AND size = 0)),
        UNIQUE (project, ticket, sha256)
      )`,
      "CREATE INDEX attachments_ticket ON attachments (project, ticket, created_at)",
      "CREATE INDEX attachments_retention ON attachments (project, done_at) WHERE done_at IS NOT NULL",
    ],
  },
  {
    version: 13,
    statements: [
      "ALTER TABLE runtime_handles ADD COLUMN heartbeat_at timestamptz",
      "ALTER TABLE runtime_handles ADD COLUMN worker_session_id text",
      "ALTER TABLE fleet_sessions ADD COLUMN heartbeat_at timestamptz",
    ],
  },
  {
    // What the owner validates (THE-885): merges, work a kind of ticket shows, escalated questions.
    // A newer submission of the same open one supersedes it (one open merge per pull request,
    // one open validation per ticket); the owner's decision becomes a `decision` inbox item.
    version: 14,
    statements: [
      `CREATE TABLE validations (
        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        project text NOT NULL,
        ticket text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('merge', 'validation', 'question')),
        what text NOT NULL,
        reason text,
        choices jsonb,
        pr jsonb,
        pr_number bigint,
        attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
        author text,
        created_at timestamptz NOT NULL,
        decided_at timestamptz,
        outcome text CHECK (outcome IN ('approved', 'changes', 'answered', 'superseded')),
        answer text,
        note text,
        decided_by text,
        CHECK ((decided_at IS NULL) = (outcome IS NULL)),
        CHECK (kind <> 'merge' OR pr_number IS NOT NULL)
      )`,
      "CREATE INDEX validations_by_project ON validations (project, decided_at, created_at)",
      "CREATE INDEX validations_by_ticket ON validations (project, ticket, created_at)",
      "CREATE UNIQUE INDEX validations_open_merge ON validations (project, pr_number) WHERE decided_at IS NULL AND kind = 'merge'",
      "CREATE UNIQUE INDEX validations_open_ticket ON validations (project, ticket) WHERE decided_at IS NULL AND kind = 'validation'",
      "ALTER TABLE inbox_items ADD COLUMN request_validation bigint",
      "CREATE UNIQUE INDEX inbox_one_decision ON inbox_items (project, request_validation) WHERE kind = 'decision'",
    ],
  },
  {
    // What happened since the owner last looked (THE-894): each person's
    // visits per organization (a cookie's id under the shared-password gate),
    // the summary they dismissed and their notification settings; and the
    // Activity feed's reads, each source by project and time.
    version: 15,
    statements: [
      `CREATE TABLE fleet_viewers (
        viewer text NOT NULL,
        organization text NOT NULL,
        seen_at timestamptz NOT NULL,
        since timestamptz,
        back_at timestamptz,
        dismissed_since timestamptz,
        notify jsonb,
        PRIMARY KEY (viewer, organization)
      )`,
      "CREATE INDEX events_feed ON events (project, created_at) WHERE kind IN ('claim', 'report', 'release', 'merge')",
      "CREATE INDEX inbox_by_time ON inbox_items (project, created_at)",
      "CREATE INDEX validations_by_time ON validations (project, created_at)",
      `CREATE INDEX "armada_worker_revoked_idx" ON "armada_worker" ("project", "endedAt") WHERE "endReason" = 'revoked'`,
    ],
  },
  {
    // ⌘K over everything and saved views (THE-895): the captions ⌘K finds, read by time; each
    // person's named filters, per organization, one name once.
    version: 16,
    statements: [
      "CREATE INDEX attachments_recent ON attachments (project, created_at) WHERE caption IS NOT NULL",
      `CREATE TABLE saved_views (
        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        organization text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
        person text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
        name text NOT NULL,
        list text NOT NULL,
        query text NOT NULL,
        created_at timestamptz NOT NULL,
        UNIQUE (organization, person, name)
      )`,
    ],
  },
  {
    // Runtime readings are separate from worker reports and expire with the silence policy.
    version: 17,
    statements: [
      "ALTER TABLE runtime_handles ADD COLUMN runtime_state text CHECK (runtime_state IN ('working', 'blocked', 'idle', 'done', 'unknown'))",
      "ALTER TABLE runtime_handles ADD COLUMN runtime_observed_at timestamptz",
      "ALTER TABLE runtime_handles ADD COLUMN runtime_changed_at timestamptz",
    ],
  },
  {
    // Herdr detects transitions that happen between coordinator readings.
    version: 18,
    statements: [
      "ALTER TABLE runtime_handles ADD COLUMN runtime_state_sequence bigint CHECK (runtime_state_sequence >= 0 AND runtime_state_sequence <= 9007199254740991)",
    ],
  },
  {
    // Relayed owner-validation decisions renew liveness just like plan and question answers.
    version: 19,
    statements: [
      "DROP INDEX inbox_answered",
      `CREATE INDEX inbox_answered ON inbox_items (project, resolved_at)
        WHERE kind IN ('question', 'plan', 'decision') AND resolved_at IS NOT NULL`,
    ],
  },
  {
    // Shipping detail is Armada data, separate from Linear's phase labels.
    version: 20,
    statements: [
      "ALTER TABLE events ADD COLUMN shipping_stage text CHECK (shipping_stage IS NULL OR (shipping_stage IN ('review', 'ci') AND phase IS NOT DISTINCT FROM 'shipping'))",
      "ALTER TABLE fleet_sessions ADD COLUMN report_shipping_stage text CHECK (report_shipping_stage IS NULL OR (report_shipping_stage IN ('review', 'ci') AND report_phase IS NOT DISTINCT FROM 'shipping'))",
    ],
  },
  {
    // The overview's saved views go with its filters (THE-1020): one project chip is all it filters on.
    version: 21,
    statements: ["DELETE FROM saved_views WHERE list = 'agents'"],
  },
  {
    // Saved views have no consumers since THE-1021; the owner approved deleting their data (THE-1029).
    version: 22,
    statements: ["DROP TABLE IF EXISTS saved_views"],
  },
  {
    // THE-1074: Conductor reports failed turns and archived workspaces distinctly.
    version: 23,
    statements: [
      "ALTER TABLE runtime_handles DROP CONSTRAINT IF EXISTS runtime_handles_runtime_state_check",
      "ALTER TABLE runtime_handles ADD CONSTRAINT runtime_handles_runtime_state_check CHECK (runtime_state IN ('working', 'blocked', 'idle', 'done', 'failed', 'gone', 'unknown'))",
    ],
  },
  {
    version: 24,
    statements: ['ALTER TABLE "armada_worker" ADD COLUMN IF NOT EXISTS "runtime" text'],
  },
  {
    // Owner chat alerts (THE-1097). Follows worker-session migration 24.
    version: 25,
    statements: [
      `CREATE TABLE owner_channels (
        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        organization text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE UNIQUE,
        project text REFERENCES projects(slug) ON DELETE CASCADE,
        format text NOT NULL CHECK (format IN ('slack', 'json')),
        alerts boolean NOT NULL DEFAULT true,
        digest jsonb NOT NULL DEFAULT '{"times":[],"days":[1,2,3,4,5]}'::jsonb,
        time_zone text NOT NULL, language text NOT NULL CHECK (language IN ('en','fr')),
        quiet jsonb, failures integer NOT NULL DEFAULT 0, paused_reason text,
        created_by text NOT NULL, created_at timestamptz NOT NULL,
        generation integer NOT NULL DEFAULT 1
      )`,
      `CREATE TABLE owner_pushes (
        id bigint GENERATED BY DEFAULT AS IDENTITY UNIQUE, updated_at timestamptz,
        channel bigint NOT NULL REFERENCES owner_channels(id) ON DELETE CASCADE,
        key text NOT NULL, created_at timestamptz NOT NULL, sent_at timestamptz,
        attempts integer NOT NULL DEFAULT 0, error text,
        payload jsonb NOT NULL, claimed_until timestamptz, claim text,
        PRIMARY KEY (channel, key)
      )`,
      `CREATE INDEX owner_pushes_unsent ON owner_pushes (channel, created_at) WHERE sent_at IS NULL`,
    ],
  },
  {
    version: 26,
    statements: [
      `CREATE TABLE ticket_paths (
      project text NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
      ticket text NOT NULL, paths text[] NOT NULL, declared_at timestamptz NOT NULL,
      PRIMARY KEY (project, ticket)
    )`,
    ],
  },
  { version: 27, statements: ["ALTER TABLE inbox_items ADD COLUMN request_deferred boolean NOT NULL DEFAULT false"] },
];

export const DB_SCHEMA_VERSION = DB_MIGRATIONS.at(-1)?.version ?? 0;

/** Any 64-bit number the app alone uses: the lock migrations take. */
const MIGRATION_LOCK = 4_849_001;

/** Applies pending migrations and returns the schema version. */
export async function migrateDatabase(db: Database, now: Date = new Date()): Promise<number> {
  const current = async (q: Queryable) =>
    Number((await q.query<{ v: unknown }>("SELECT max(version) AS v FROM armada_migrations")).rows[0]?.v ?? 0);
  // The usual case, without a lock: everything applied already.
  const applied = await db
    .query<{ t: unknown }>("SELECT to_regclass('armada_migrations') AS t")
    .then((rs) => rs.rows[0]?.t !== null && rs.rows[0]?.t !== undefined);
  if (applied && (await current(db)) >= DB_SCHEMA_VERSION) return DB_SCHEMA_VERSION;
  for (const m of DB_MIGRATIONS)
    await transaction(db, async (tx) => {
      // Whoever comes second waits here, then finds the version applied.
      await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      await tx.query(
        "CREATE TABLE IF NOT EXISTS armada_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL)",
      );
      if ((await current(tx)) >= m.version) return;
      for (const statement of m.statements) await tx.query(statement);
      await tx.query("INSERT INTO armada_migrations (version, applied_at) VALUES ($1, $2)", [m.version, now]);
    });
  return DB_SCHEMA_VERSION;
}

// ------------------------------------------------------------ opening

/** The variables that name the database, in order: ours first, then the one Neon's Vercel integration sets. */
export const DATABASE_VARIABLES = ["ARMADA_DATABASE_URL", "DATABASE_URL"] as const;
export const DATABASE_VARIABLE = DATABASE_VARIABLES[0];

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * The database URL the environment gives, or null. `pglite:` (in memory) and
 * `pglite:<directory>` run Postgres inside the process: tests and local
 * development only, never in production, where its data would not survive.
 */
export function databaseUrlOf(env: Env): string | null {
  for (const name of DATABASE_VARIABLES) {
    const v = env[name]?.trim();
    if (!v) continue;
    if (v.startsWith("pglite:")) return env.NODE_ENV === "production" ? null : v;
    return /^postgres(ql)?:\/\//i.test(v) ? v : null;
  }
  return null;
}

/** An error message without the URL's password, even if a driver quoted the URL. */
export function redactDatabase(err: unknown, url?: string | null): string {
  let message = err instanceof Error ? err.message : String(err);
  const password = url ? safeUrl(url)?.password : "";
  if (password) message = message.split(decodeURIComponent(password)).join("***").split(password).join("***");
  return message.replace(/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+@/gi, "$1***@");
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Postgres in the process (PGlite) behind the pool's interface. One session
 * serves every caller: a connection (a transaction) is held by one caller at a
 * time, so two transactions never mix. A single statement outside them runs at
 * once, as on its own connection would, but in that one session it joins
 * whatever transaction is open: Better Auth's hooks read while it holds one.
 * Fine for tests and local development, not a production database.
 */
export async function pgliteDatabase(dataDir?: string): Promise<Database> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  let queue: Promise<void> = Promise.resolve();
  const lock = async (): Promise<() => void> => {
    let free = () => {};
    const held = new Promise<void>((resolve) => {
      free = resolve;
    });
    const before = queue;
    queue = queue.then(() => held);
    await before;
    return free;
  };
  const run = async <R>(text: string, params?: readonly unknown[]): Promise<Rows<R>> => {
    const rs = await pg.query<R>(text, params ? [...params] : []);
    return { rows: rs.rows, rowCount: rs.affectedRows ?? 0 };
  };
  return {
    query: <R = Row>(text: string, params?: readonly unknown[]) => run<R>(text, params),
    async connect() {
      const free = await lock();
      let released = false;
      return {
        query: <R = Row>(text: string, params?: readonly unknown[]) => run<R>(text, params),
        release() {
          if (released) return;
          released = true;
          free();
        },
      };
    },
    async end() {
      await pg.close();
    },
  };
}

/**
 * node-postgres verifies the server's certificate for `sslmode=require` (and
 * `prefer`, `verify-ca`) already, and warns that it does; saying `verify-full`
 * keeps that check and the log quiet. Neon's URLs carry `sslmode=require`.
 */
function strictSsl(url: string): string {
  const u = safeUrl(url);
  if (!u) return url;
  const mode = u.searchParams.get("sslmode");
  // A remote database without a mode would be reached in plain text: TLS, verified, unless the URL says otherwise.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.hostname.endsWith(".localhost");
  if (mode ? !["prefer", "require", "verify-ca"].includes(mode) : local) return url;
  u.searchParams.set("sslmode", "verify-full");
  return u.toString();
}

/** A node-postgres pool, released before the platform suspends the function. */
async function pgDatabase(raw: string): Promise<Database> {
  const url = strictSsl(raw);
  const { Pool } = await import("pg");
  // A stalled query fails rather than hold a request: the dashboard falls back to Linear and GitHub.
  const pool = new Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 20_000,
  });
  // An idle client losing its connection must not crash the process.
  pool.on("error", (err) => console.error(`armada dashboard: database connection lost: ${redactDatabase(err, url)}`));
  try {
    const { attachDatabasePool } = await import("@vercel/functions");
    attachDatabasePool(pool);
  } catch {
    // Not on Vercel's runtime: the pool lives as long as the process.
  }
  return {
    async query<R = Row>(text: string, params?: readonly unknown[]) {
      const rs = await pool.query(text, params ? [...params] : undefined);
      return { rows: rs.rows as R[], rowCount: rs.rowCount ?? 0 };
    },
    async connect() {
      const client = await pool.connect();
      return {
        async query<R = Row>(text: string, params?: readonly unknown[]) {
          const rs = await client.query(text, params ? [...params] : undefined);
          return { rows: rs.rows as R[], rowCount: rs.rowCount ?? 0 };
        },
        // A destroyed client closes its connection, and whatever transaction it held with it.
        release: (destroy?: boolean) => client.release(destroy === true),
      };
    },
    // Idempotent, like PGlite's close.
    end: async () => {
      if (!pool.ending) await pool.end();
    },
  };
}

/** Opens the database and brings its schema up to date. The password never appears in an error. */
export async function openDatabase(url: string, { migrate = true }: { migrate?: boolean } = {}): Promise<Database> {
  let db: Database;
  try {
    if (url.startsWith("pglite:")) {
      const dir = url.slice("pglite:".length).replace(/^\/\//, "");
      db = await pgliteDatabase(dir && dir !== "memory" ? dir : undefined);
    } else db = await pgDatabase(url);
  } catch (err) {
    throw new Error(`the app's database cannot be opened: ${redactDatabase(err, url)}`);
  }
  if (!migrate) return db;
  try {
    await migrateDatabase(db);
  } catch (err) {
    await db.end().catch(() => {});
    throw new Error(`the app's database is unavailable: ${redactDatabase(err, url)}`);
  }
  return db;
}
