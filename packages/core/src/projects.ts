// Reading the configuration of a registered project: its armada.toml on the
// default branch of its repository, or the registry record when that file
// cannot be read. Shared by `armada status --all` and the dashboard.
import { type ArmadaConfig, CONFIG_FILE, configTemplate, parseConfig } from "./config.ts";
import { fetchDefaultBranchFile } from "./github.ts";
import type { Fetch } from "./linear.ts";
import type { ProjectInput } from "./live.ts";

export interface ProjectConfigReading {
  config: ArmadaConfig;
  /** Set when armada.toml could not be read and the registry record was used instead. */
  warning: string | null;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function readProjectConfig(
  p: ProjectInput,
  opts: { githubToken: string | null; fetch?: Fetch },
): Promise<ProjectConfigReading> {
  const fallback = (why: string) => ({
    config: parseConfig(configTemplate(p), `registry record ${p.slug}`),
    warning: `${CONFIG_FILE} not read (${why}); using the registry record with default labels and policy`,
  });
  if (!opts.githubToken) return fallback("no GitHub token");
  try {
    const text = await fetchDefaultBranchFile({
      token: opts.githubToken,
      repository: p.repository,
      path: CONFIG_FILE,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    if (text === null) return fallback(`not on the default branch of ${p.repository}`);
    return { config: parseConfig(text, `${p.repository}:${CONFIG_FILE}`), warning: null };
  } catch (err) {
    return fallback(message(err));
  }
}
