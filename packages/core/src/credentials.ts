// The one place Armada reads its tokens. Today: environment variables, then
// the GitHub CLI login. A machine credential store plugs in here, so every
// command keeps asking this function and nothing else.

export interface Credentials {
  /** Linear personal API key, or null when none is configured. */
  linearApiKey: string | null;
  /** GitHub token, or null when none is configured. */
  githubToken: string | null;
}

export interface CredentialSources {
  env: Record<string, string | undefined>;
  /** Token from the GitHub CLI (`gh auth token`); called only when the environment has none. */
  ghToken?: () => string | null;
}

const clean = (v: string | null | undefined) => v?.trim() || null;

/** Linear: LINEAR_API_KEY. GitHub: GITHUB_TOKEN, then GH_TOKEN, then `gh auth token`. */
export function resolveCredentials({ env, ghToken }: CredentialSources): Credentials {
  return {
    linearApiKey: clean(env.LINEAR_API_KEY),
    githubToken: clean(env.GITHUB_TOKEN) ?? clean(env.GH_TOKEN) ?? clean(ghToken?.()),
  };
}
