// `armada status --all`: the status of every project of the organization's
// registry on Armada, each read with the armada.toml on its repository's
// default branch, and with its own Linear key when it keeps one (THE-859).
import { type ArmadaProject, LINEAR_KEY, loadStatus, readProjectConfig, type StatusReport } from "@armada/core";
import { apiOf } from "./api.ts";
import { loadCredentials } from "./auth.ts";
import { type Io, missingKey } from "./io.ts";
import { requireSignIn } from "./login.ts";
import { recordPresence } from "./presence.ts";
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

export async function statusAll(io: Io, json: boolean): Promise<number> {
  const { credentials } = await loadCredentials(io);
  // The registry is on Armada, which may also give the Linear key: the sign-in comes first.
  const signIn = requireSignIn(credentials);
  const linearApiKey = credentials.linearApiKey;
  if (!linearApiKey) throw missingKey(LINEAR_KEY);
  const api = apiOf(io, credentials.armadaApi.url);
  const records: ArmadaProject[] = await api.projects(signIn);

  const projects = await Promise.all(
    records.map(async (p): Promise<ProjectStatus> => {
      const base = { slug: p.slug, name: p.name, repository: p.repository };
      let warning: string | null = null;
      try {
        const read = await readProjectConfig(p, {
          githubToken: credentials.githubToken,
          ...(io.fetch ? { fetch: io.fetch } : {}),
        });
        warning = read.warning;
        const config = read.config;
        // A project that keeps its own Linear key (another workspace) is read with it; the environment's still wins.
        const own =
          p.ownLinearKey && !io.env.LINEAR_API_KEY?.trim()
            ? (await api.credentials(signIn, { project: p.slug })).linear?.apiKey
            : undefined;
        await recordPresence(io, config, credentials);
        const report = await loadStatus(config, {
          linearApiKey: own ?? linearApiKey,
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
