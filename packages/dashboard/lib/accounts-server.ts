// Accounts inside server code: the one Better Auth instance of this process,
// and the checks every page, route and server action runs first. They are a
// second check behind proxy.ts, so a read or a write refuses a viewer without
// a session even if a matcher change ever left it outside the proxy.
import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import {
  type Auth,
  consoleSender,
  createAuth,
  firstOrganization,
  organizationOf,
  type ViewerOrganization,
} from "./accounts";
import { type AuthSettings, accountsModeOf, signatureOf, WELCOME_PATH } from "./accounts-settings";
import { appDatabase } from "./app-db";
import { LOGIN_PATH } from "./auth";
import type { Database } from "./db";

export type { ViewerOrganization } from "./accounts";

export interface Accounts {
  auth: Auth;
  client: Database;
  settings: AuthSettings;
  home?: string | undefined;
}

// One instance per server process, kept across hot reloads in development and
// rebuilt if the settings change. A failed open is retried on the next request.
const holder = globalThis as unknown as { __armadaAccounts?: { key: string; opening: Promise<Accounts> } };

/** The accounts of this deployment; null while they are not configured (the password gate applies then). */
export async function accounts(): Promise<Accounts | null> {
  const mode = accountsModeOf(process.env);
  if (mode.kind === "off") return null;
  // Fails closed: never the password gate while accounts are half set up.
  if (mode.kind === "incomplete") throw new Error(`accounts are not fully configured: set ${mode.missing.join(", ")}`);
  const key = JSON.stringify(mode.settings);
  if (holder.__armadaAccounts?.key !== key) {
    const opening = appDatabase().then((client) => {
      if (!client) throw new Error("the app's database is not configured");
      return {
        client,
        settings: mode.settings,
        // The only email sender for now: messages go to the server log (see consoleSender).
        auth: createAuth(mode.settings, { client, sender: consoleSender }),
      };
    });
    opening.catch(() => {
      if (holder.__armadaAccounts?.opening === opening) holder.__armadaAccounts = undefined;
    });
    holder.__armadaAccounts = { key, opening };
  }
  return holder.__armadaAccounts.opening;
}

export async function requireAccounts(): Promise<Accounts> {
  const a = await accounts();
  if (!a) throw new Error("accounts are not configured on this dashboard");
  return a;
}

export interface Viewer {
  user: { id: string; name: string; email: string; emailVerified: boolean };
  /** The organization the viewer works in: the session's active one, else their oldest membership. */
  organization: ViewerOrganization | null;
  /** How requests from this viewer are signed on the ticket. */
  signature: string;
}

/** The signed-in viewer of this request, or null. Read once per request. */
export const currentViewer = cache(async (): Promise<Viewer | null> => {
  const { auth, client } = await requireAccounts();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const { user } = session;
  const active = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;
  return {
    user: { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified },
    organization: await organizationOf(client, user.id, active),
    signature: signatureOf(user),
  };
});

/** Call first in every server action and data read. Sends a viewer without a session to the sign-in page. */
export async function requireSession(): Promise<Viewer> {
  const viewer = await currentViewer();
  if (!viewer) redirect(LOGIN_PATH);
  return viewer;
}

/** Like `requireSession`, for fleet data: the viewer must belong to an organization. */
export async function requireMember(): Promise<Viewer & { organization: ViewerOrganization }> {
  const viewer = await requireSession();
  if (!viewer.organization) redirect(WELCOME_PATH);
  return { ...viewer, organization: viewer.organization };
}

/** The deployment's first organization: it owns the projects registered without one. */
export async function homeOrganization(): Promise<string | null> {
  const a = await requireAccounts();
  // It never changes once it exists (organizations cannot be deleted), so it is read until found, then kept.
  a.home ??= (await firstOrganization(a.client))?.id;
  return a.home ?? null;
}
