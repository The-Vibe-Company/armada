import { checkpointIdentityKey } from "./identity.ts";
import type { Journal } from "./journal.ts";
import { mcpDigest } from "./mcp.ts";
import type { Grant, McpConfiguration } from "./protocol.ts";

/** Admit immutable revisions and register transient secrets before durable acknowledgement. */
export function recordMcpRevision(
  journal: Journal,
  grant: Grant,
  configuration: McpConfiguration,
  values: readonly string[],
): void {
  const prefix = `mcp:v2:${checkpointIdentityKey(grant)}:`,
    key = prefix + mcpDigest(configuration.revision),
    digest = mcpDigest(configuration);
  const previous = journal.db.query("SELECT value FROM metadata WHERE key=?").get(key) as {
    value: string;
  } | null;
  const current = journal.db.query("SELECT value FROM metadata WHERE key=?").get(`${prefix}current`) as {
    value: string;
  } | null;
  if (previous && previous.value !== digest) throw Error("mcp_revision_conflict");
  if (previous && current && current.value !== key) throw Error("stale_mcp_revision");
  if (
    !previous &&
    Number(
      (
        journal.db
          .query("SELECT count(*) AS n FROM metadata WHERE substr(key,1,?)=? AND key<>?")
          .get(prefix.length, prefix, `${prefix}current`) as { n: number }
      ).n,
    ) >= 4096
  )
    throw Error("mcp_revision_limit");
  if (Date.now() >= grant.expiresAt) throw Error("unauthorized");
  // Register before SQL metadata, snapshot replacement, events, native stderr or any acknowledgement.
  journal.registerSecrets(values);
  journal.db.transaction(() => {
    journal.db.query("INSERT OR REPLACE INTO metadata VALUES(?,?)").run(key, digest);
    journal.db.query("INSERT OR REPLACE INTO metadata VALUES(?,?)").run(`${prefix}current`, key);
  })();
}
