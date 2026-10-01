// Linking the Armada GitHub App to an organization in one click (THE-852).
// An owner or admin's Install on GitHub button leads to GITHUB_INSTALL_PATH,
// which signs a short-lived state (the organization, the person, a nonce also
// kept in a cookie) and sends them to GitHub's install page. GitHub sends them
// back to the app's Setup URL, the GitHub page, which hands GitHub's query to
// GITHUB_SETUP_PATH: `linkFromSetup` checks the state and the cookie, then
// links the installation under the Link button's rule (`linkForViewer`):
// only when GitHub lists it among those the person can reach, asked with
// their own GitHub sign-in. The nonce is used once: the cookie is cleared on
// return, so a state copied from a URL cannot link anything again.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { COOKIE_PREFIX, GITHUB_PATH } from "./accounts-settings";
import { type Database, transaction } from "./db";
import { type Fetch, type Installation, type LinkOutcome, linkInstallation, userInstallations } from "./github-app";
import type { GithubError, GithubNotice } from "./i18n";
import { type Actor, recordEvent } from "./vault";

/** How long a state is accepted back: picking the account and the repositories on GitHub. */
export const INSTALL_STATE_TTL_MS = 30 * 60 * 1000;
/** Holds the state's nonce in the browser that clicked Install, until GitHub sends it back. */
export const INSTALL_COOKIE = `${COOKIE_PREFIX}.github_install`;

/** Who clicked Install, for which organization, and the nonce their browser keeps. */
export interface InstallState {
  organization: string;
  user: string;
  nonce: string;
}

export const newNonce = () => randomBytes(18).toString("base64url");

const base64url = (data: string) => Buffer.from(data).toString("base64url");

// A key of its own, derived from the accounts secret, so the state's signature never doubles as a session's.
const signature = (secret: string, payload: string) =>
  createHmac("sha256", createHmac("sha256", secret).update("armada:github-app-install-state").digest())
    .update(payload)
    .digest("base64url");

/** The state the install page carries: who, for which organization, until when, signed. Not a secret. */
export function installState(secret: string, who: InstallState, now: Date): string {
  const payload = base64url(
    JSON.stringify({ o: who.organization, u: who.user, n: who.nonce, exp: now.getTime() + INSTALL_STATE_TTL_MS }),
  );
  return `${payload}.${signature(secret, payload)}`;
}

/** The state GitHub sent back, or null when it is forged, altered or expired. */
export function readInstallState(secret: string, state: string, now: Date): InstallState | null {
  const [payload, signed, ...rest] = state.split(".");
  if (!payload || !signed || rest.length > 0) return null;
  const expected = Buffer.from(signature(secret, payload));
  const given = Buffer.from(signed);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
    if (typeof p.o !== "string" || typeof p.u !== "string" || typeof p.n !== "string" || typeof p.exp !== "number")
      return null;
    return p.exp > now.getTime() ? { organization: p.o, user: p.u, nonce: p.n } : null;
  } catch {
    return null;
  }
}

/** GitHub's page that installs the app (`appUrl`: https://github.com/apps/<slug>), carrying the state back. */
export const installUrl = (appUrl: string, state: string) =>
  `${appUrl}/installations/new?state=${encodeURIComponent(state)}`;

/** What a link or unlink did, as the GitHub page's query shows it. */
export type GithubResult = { done: GithubNotice } | { error: GithubError };

export const githubPage = (result: GithubResult) =>
  "done" in result ? `${GITHUB_PATH}?done=${result.done}` : `${GITHUB_PATH}?error=${result.error}`;

/** The person linking, in the organization they are in now. */
export interface LinkViewer {
  user: string;
  label: string;
  organization: string;
  role: string;
}

export const linkViewerOf = (v: {
  user: { id: string };
  signature: string;
  organization: { id: string; role: string };
}): LinkViewer => ({ user: v.user.id, label: v.signature, organization: v.organization.id, role: v.organization.role });

export const managesOrganization = (viewer: { role: string }) => viewer.role === "owner" || viewer.role === "admin";

/** `linkInstallation` and, for a new link, its line in the audit list, in one transaction. */
export async function linkAndRecord(
  db: Database,
  link: { organization: string; installation: number; reachable: Installation[]; by: Actor; now: Date },
): Promise<LinkOutcome> {
  return transaction(db, async (tx) => {
    const outcome = await linkInstallation(tx, link);
    if (outcome !== "linked") return outcome;
    const account = link.reachable.find((i) => i.id === link.installation)?.account ?? String(link.installation);
    await recordEvent(tx, link.organization, {
      at: link.now.toISOString(),
      action: "link",
      keys: ["github-app"],
      actor: link.by,
      detail: `installation ${link.installation} on ${account}`,
    });
    return outcome;
  });
}

export interface LinkDeps {
  viewer: LinkViewer;
  /** The viewer's GitHub sign-in token (`viewerGithubToken`), asked for only once the rest holds. */
  githubToken: () => Promise<string | null>;
  fetch: Fetch;
  now: Date;
}

/**
 * The one rule both the Link button and the Setup URL link by: an owner or
 * admin, signed in with GitHub, links an installation GitHub lists among
 * those they can reach. Linking again keeps the link. A GitHub or database
 * failure is logged and answered `failed`.
 */
export async function linkForViewer(db: Database, installation: number, deps: LinkDeps): Promise<GithubResult> {
  const { viewer } = deps;
  if (!managesOrganization(viewer)) return { error: "forbidden" };
  if (!Number.isSafeInteger(installation) || installation <= 0) return { error: "unreachable" };
  const token = await deps.githubToken();
  if (!token) return { error: "no-github" };
  try {
    const outcome = await linkAndRecord(db, {
      organization: viewer.organization,
      installation,
      reachable: await userInstallations(deps.fetch, token),
      by: { kind: "person", id: viewer.user, label: viewer.label },
      now: deps.now,
    });
    return outcome === "unreachable" ? { error: "unreachable" } : { done: "linked" };
  } catch (err) {
    console.error(
      `armada dashboard: installation ${installation} not linked: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { error: "failed" };
  }
}

/**
 * GitHub sent the person back to the Setup URL with an installation and the
 * state. It is linked only when the state is genuine and unexpired, was made
 * for this person in the organization they are in now, and carries the nonce
 * this browser kept (`nonce`, from INSTALL_COOKIE); then `linkForViewer`
 * decides.
 */
export async function linkFromSetup(
  db: Database,
  setup: LinkDeps & { secret: string; state: string; nonce: string | null; installation: number },
): Promise<GithubResult> {
  const state = readInstallState(setup.secret, setup.state, setup.now);
  if (!state || !setup.nonce || state.nonce !== setup.nonce) return { error: "state" };
  if (state.user !== setup.viewer.user || state.organization !== setup.viewer.organization) return { error: "state" };
  return linkForViewer(db, setup.installation, setup);
}
