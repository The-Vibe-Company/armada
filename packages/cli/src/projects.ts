// `armada status --all`: the status of every project in the registry, each
// read with the armada.toml on its repository's default branch.
import {
  type ArmadaConfig,
  CONFIG_FILE,
  configTemplate,
  fetchDefaultBranchFile,
  LINEAR_KEY,
  listProjects,
  loadStatus,
  missingKeyMessage,
  openTurso,
  type ProjectRecord,
  parseConfig,
  STORED_KEYS,
  type StatusReport,
} from "@armada/core";
import { loadCredentials } from "./auth.ts";
import { type Io, UsageError } from "./io.ts";
import { renderStatus } from "./render.ts";

export interface ProjectStatus {
  slug: string;
  name: string;
  repository: string;
  /** Null when the project could not be read; `error` says why. */
  report: StatusReport | null;
  error: string | null;
  /** Set when the project's armada.toml could not be read and the registry's record was used instead. */
  configWarning: string | null;
}

export interface AllStatus {
  schemaVersion: 1;
  projects: ProjectStatus[];
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function projectConfig(
  p: ProjectRecord,
  githubToken: string | null,
  io: Io,
): Promise<{ config: ArmadaConfig; warning: string | null }> {
  const fallback = (why: string) => ({
    config: parseConfig(configTemplate(p), `registry record ${p.slug}`),
    warning: `${CONFIG_FILE} not read (${why}); using the registry record with default labels and policy`,
  });
  if (!githubToken) return fallback("no GitHub token");
  try {
    const text = await fetchDefaultBranchFile({
      token: githubToken,
      repository: p.repository,
      path: CONFIG_FILE,
      ...(io.fetch ? { fetch: io.fetch } : {}),
    });
    if (text === null) return fallback(`not on the default branch of ${p.repository}`);
    return { config: parseConfig(text, `${p.repository}:${CONFIG_FILE}`), warning: null };
  } catch (err) {
    return fallback(message(err));
  }
}

export async function statusAll(io: Io, json: boolean): Promise<number> {
  const { credentials } = await loadCredentials(io);
  const linearApiKey = credentials.linearApiKey;
  if (!linearApiKey) throw new UsageError(missingKeyMessage(LINEAR_KEY));
  const tursoKey = STORED_KEYS.find((k) => k.name === "tursoUrl");
  if (!credentials.tursoUrl && tursoKey) throw new UsageError(missingKeyMessage(tursoKey));

  const db = await openTurso({ url: credentials.tursoUrl ?? "", token: credentials.tursoToken });
  let records: ProjectRecord[];
  try {
    records = await listProjects(db);
  } finally {
    db.close();
  }

  const projects = await Promise.all(
    records.map(async (p): Promise<ProjectStatus> => {
      const base = { slug: p.slug, name: p.name, repository: p.repository };
      let warning: string | null = null;
      try {
        const read = await projectConfig(p, credentials.githubToken, io);
        warning = read.warning;
        const config = read.config;
        const report = await loadStatus(config, {
          linearApiKey,
          githubToken: credentials.githubToken,
          ...(io.fetch ? { fetch: io.fetch } : {}),
          ...(io.now ? { now: io.now } : {}),
        });
        return { ...base, report, error: null, configWarning: warning };
      } catch (err) {
        return { ...base, report: null, error: message(err), configWarning: warning };
      }
    }),
  );

  const all: AllStatus = { schemaVersion: 1, projects };
  if (json) io.stdout(`${JSON.stringify(all, null, 2)}\n`);
  else if (!projects.length)
    io.stdout("No project is registered yet. Run `armada init` in a repository to register it.\n");
  else
    io.stdout(
      projects
        .map((p) => {
          if (!p.report)
            return `${p.name} (${p.slug}) · ${p.repository}\n  ! not read: ${p.error}\n${p.configWarning ? `  ! ${p.configWarning}\n` : ""}`;
          return `${renderStatus(p.report)}${p.configWarning ? `  ! ${p.configWarning}\n` : ""}`;
        })
        .join(`\n${"─".repeat(60)}\n\n`),
    );
  return projects.some((p) => p.error) ? 1 : 0;
}
