// The accounts database: people, sessions, organizations, members and
// invitations (and, in later slices, device codes, API keys and secrets). It is
// a libSQL database of its own, separate from the fleet's Turso database.
// Better Auth reaches it through Kysely; `LibsqlDialect` is the small driver
// over the @libsql/client the dashboard already ships. Its schema comes from
// `AUTH_MIGRATIONS`, applied once each in order, never from Better Auth's
// automatic migration: a test checks the two agree.
import type { Client, InValue, Transaction } from "@libsql/client";
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

class LibsqlConnection implements DatabaseConnection {
  private tx: Transaction | null = null;

  constructor(private readonly client: Client) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const rs = await (this.tx ?? this.client).execute({ sql: query.sql, args: query.parameters as InValue[] });
    return {
      rows: rs.rows.map((row) => Object.fromEntries(rs.columns.map((c, i) => [c, row[i]]))) as R[],
      numAffectedRows: BigInt(rs.rowsAffected),
      ...(rs.lastInsertRowid !== undefined ? { insertId: rs.lastInsertRowid } : {}),
    };
  }

  // biome-ignore lint/correctness/useYield: libSQL has no cursor; Better Auth never streams.
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("the libSQL driver does not stream queries");
  }

  async begin(): Promise<void> {
    this.tx = await this.client.transaction("write");
  }

  async finish(commit: boolean): Promise<void> {
    const tx = this.tx;
    this.tx = null;
    if (!tx) return;
    try {
      if (commit) await tx.commit();
      else await tx.rollback();
    } finally {
      tx.close();
    }
  }
}

class LibsqlDriver implements Driver {
  constructor(private readonly client: Client) {}
  async init(): Promise<void> {}
  // One connection object per use: a transaction lives on its own libSQL stream.
  async acquireConnection(): Promise<DatabaseConnection> {
    return new LibsqlConnection(this.client);
  }
  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await (connection as LibsqlConnection).begin();
  }
  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await (connection as LibsqlConnection).finish(true);
  }
  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await (connection as LibsqlConnection).finish(false);
  }
  async releaseConnection(): Promise<void> {}
  // The client belongs to whoever opened it (`openAuthDatabase`).
  async destroy(): Promise<void> {}
}

export class LibsqlDialect implements Dialect {
  constructor(private readonly client: Client) {}
  createAdapter = () => new SqliteAdapter();
  createDriver = () => new LibsqlDriver(this.client);
  createQueryCompiler = () => new SqliteQueryCompiler();
  createIntrospector = (db: Parameters<Dialect["createIntrospector"]>[0]) => new SqliteIntrospector(db);
}

/**
 * The accounts schema, one entry per version. Each version is applied once, in
 * order, in one write batch; statements are idempotent so two servers starting
 * together are safe. Never edit an applied version: add one. Version 1 is what
 * Better Auth 1.7 needs for email and password, GitHub, the organization plugin
 * and database rate limiting. THE-839 adds the device-authorization and API-key
 * tables as version 2.
 */
export const AUTH_MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS "user" (
        "id" text NOT NULL PRIMARY KEY,
        "name" text NOT NULL,
        "email" text NOT NULL UNIQUE,
        "emailVerified" integer NOT NULL,
        "image" text,
        "createdAt" date NOT NULL,
        "updatedAt" date NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS "session" (
        "id" text NOT NULL PRIMARY KEY,
        "expiresAt" date NOT NULL,
        "token" text NOT NULL UNIQUE,
        "createdAt" date NOT NULL,
        "updatedAt" date NOT NULL,
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
        "accessTokenExpiresAt" date,
        "refreshTokenExpiresAt" date,
        "scope" text,
        "password" text,
        "createdAt" date NOT NULL,
        "updatedAt" date NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS "verification" (
        "id" text NOT NULL PRIMARY KEY,
        "identifier" text NOT NULL,
        "value" text NOT NULL,
        "expiresAt" date NOT NULL,
        "createdAt" date NOT NULL,
        "updatedAt" date NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS "organization" (
        "id" text NOT NULL PRIMARY KEY,
        "name" text NOT NULL,
        "slug" text NOT NULL UNIQUE,
        "logo" text,
        "createdAt" date NOT NULL,
        "metadata" text
      )`,
      `CREATE TABLE IF NOT EXISTS "member" (
        "id" text NOT NULL PRIMARY KEY,
        "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
        "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
        "role" text NOT NULL,
        "createdAt" date NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS "invitation" (
        "id" text NOT NULL PRIMARY KEY,
        "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
        "email" text NOT NULL,
        "role" text,
        "status" text NOT NULL,
        "expiresAt" date NOT NULL,
        "createdAt" date NOT NULL,
        "inviterId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS "rateLimit" (
        "id" text NOT NULL PRIMARY KEY,
        "key" text NOT NULL UNIQUE,
        "count" integer NOT NULL,
        "lastRequest" bigint NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId")`,
      `CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId")`,
      `CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier")`,
      `CREATE INDEX IF NOT EXISTS "member_organizationId_idx" ON "member" ("organizationId")`,
      `CREATE INDEX IF NOT EXISTS "member_userId_idx" ON "member" ("userId")`,
      `CREATE INDEX IF NOT EXISTS "invitation_organizationId_idx" ON "invitation" ("organizationId")`,
      `CREATE INDEX IF NOT EXISTS "invitation_email_idx" ON "invitation" ("email")`,
    ],
  },
];

export const AUTH_SCHEMA_VERSION = AUTH_MIGRATIONS.at(-1)?.version ?? 0;

/** Applies pending migrations and returns the schema version. */
export async function migrateAuth(client: Client, now: Date = new Date()): Promise<number> {
  await client.execute(
    "CREATE TABLE IF NOT EXISTS armada_auth_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const current = Number(
    (await client.execute("SELECT max(version) AS v FROM armada_auth_migrations")).rows[0]?.v ?? 0,
  );
  for (const m of AUTH_MIGRATIONS) {
    if (m.version <= current) continue;
    await client.batch(
      [
        ...m.statements,
        {
          sql: "INSERT OR IGNORE INTO armada_auth_migrations (version, applied_at) VALUES (?, ?)",
          args: [m.version, now.toISOString()],
        },
      ],
      "write",
    );
  }
  return Math.max(current, AUTH_SCHEMA_VERSION);
}

/** Opens the accounts database and brings its schema up to date. The token never appears in an error. */
export async function openAuthDatabase({ url, token }: { url: string; token: string | null }): Promise<Client> {
  const { createClient } = await import("@libsql/client");
  const client = createClient(token ? { url, authToken: token } : { url });
  try {
    await migrateAuth(client);
  } catch (err) {
    client.close();
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`the accounts database is unavailable: ${token ? message.split(token).join("***") : message}`);
  }
  return client;
}
