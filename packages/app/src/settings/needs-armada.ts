// Where the fleet needs the Armada web sign-in (THE-2071), read from what the
// daemon already sent: the account, its plugins and a project's folded state.
// Signed out, those places say "Sign in to Armada in Settings" (NeedsArmada.tsx).
import type { DaemonState } from "@/protocol/client";

type Reading = Pick<DaemonState, "account" | "plugins">;

/** The account is known and nobody is signed in (an older daemon, or one not read yet, says neither). */
const signedOut = (state: Reading) => state.account?.signedIn === false;

const contributions = (state: Reading, seam: string, kind: string) =>
  (state.plugins?.plugins ?? []).flatMap((plugin) =>
    plugin.enabled ? plugin.contributions.filter((c) => c.seam === seam && c.kind === kind) : [],
  );

/** Signed out with a Conductor runtime on: launch tokens and worker sessions come from Armada, so no worker launches there. */
export function conductorNeedsSignIn(state: Reading): boolean {
  return signedOut(state) && contributions(state, "runtime", "conductor").length > 0;
}

/**
 * Signed out, and the project's Linear tracker has no key: none in the
 * daemon's keychain and Linear never read for it (a key from the daemon's
 * environment would have read it). The organization's key would be its key.
 */
export function linearNeedsSignIn(
  state: Reading,
  project: string,
  readAt: Record<string, string> | undefined,
): boolean {
  if (!signedOut(state) || readAt?.linear) return false;
  return contributions(state, "tracker", "linear").some((c) => {
    const projects = (c.config as { projects?: unknown } | null)?.projects;
    const tracked = typeof projects === "object" && projects !== null && Object.hasOwn(projects, project);
    return tracked && !c.secrets.some((s) => s.name === "LINEAR_API_KEY" && s.set);
  });
}
