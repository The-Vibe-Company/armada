export const OAUTH_PROVIDERS = ["github", "google"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<OAuthProvider, string> = {
  github: "GitHub",
  google: "Google",
};

/** `NEXT_PUBLIC_AUTH_PROVIDERS="github,google"`: the social buttons to show. Unknown names are ignored. */
export function enabledProviders(raw: string | undefined): OAuthProvider[] {
  if (!raw) return [];
  const wanted = new Set(
    raw
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  return OAUTH_PROVIDERS.filter((provider) => wanted.has(provider));
}

export function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}
