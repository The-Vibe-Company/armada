// Accounts and organizations, with Better Auth. Built from the settings
// (`auth.ts`), the accounts database (`auth-db.ts`) and an email sender, all
// injected, so tests run the real thing on a local `file:` database.
//
// Who gets in: an account is created only for an address listed in
// ARMADA_AUTH_OWNER_EMAILS or holding a pending invitation, and only an owner
// address creates organizations. Otherwise the first stranger to sign in could
// create the deployment's first organization, which adopts every project.
//
// The terminal signs in through two plugins (THE-839): device authorization
// for `armada login` (a code confirmed on the /device page) and API keys owned
// by an organization for headless coordinators. The CLI reaches both through
// `/api/cli` (`cli-api.ts`), never through the browser's cookie.
import { apiKey } from "@better-auth/api-key";
import type { Client } from "@libsql/client";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import {
  API_KEY_PREFIX,
  AUTH_API_PREFIX,
  type AuthSettings,
  CLI_CLIENT_ID,
  COOKIE_PREFIX,
  DEVICE_PATH,
  INVITATION_PATH,
} from "./accounts-settings";
import { LOGIN_PATH } from "./auth";
import { LibsqlDialect } from "./auth-db";

export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (v: unknown): v is Role => ROLES.includes(v as Role);

export interface EmailMessage {
  kind: "verification" | "invitation";
  to: string;
  subject: string;
  text: string;
  /** The link the message carries. */
  url: string;
}

/** How the dashboard sends email. Replace `consoleSender` with a real provider behind this interface. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Writes each message to the server log instead of sending it. The links it
 * logs let their holder verify an address or open an invitation, so the log is
 * as private as the accounts: owners copy invitation links from the
 * Organization page, which is the intended way until a provider is plugged in.
 */
export const consoleSender: EmailSender = {
  async send(m) {
    console.info(`armada dashboard: email (${m.kind}) to ${m.to}: ${m.subject}\n${m.url}`);
  },
};

export interface AccountsDeps {
  client: Client;
  sender: EmailSender;
  now?: () => Date;
}

export const invitationUrl = (baseUrl: string, id: string) =>
  new URL(`${INVITATION_PATH}/${encodeURIComponent(id)}`, baseUrl).toString();

/** SQLite stores Better Auth's dates as ISO strings, or as numbers in older rows. */
const timeOf = (v: unknown) => (typeof v === "number" ? v : Date.parse(String(v)));

/** Whether this address has an invitation it can still accept. */
export async function hasPendingInvitation(client: Client, email: string, now: Date): Promise<boolean> {
  const rs = await client.execute({
    sql: `SELECT "expiresAt" FROM "invitation" WHERE lower("email") = ? AND "status" = 'pending'`,
    args: [email.trim().toLowerCase()],
  });
  return rs.rows.some((r) => timeOf(r.expiresAt) > now.getTime());
}

/** The deployment's first organization: it owns every project registered without one. */
export async function firstOrganization(client: Client): Promise<{ id: string; name: string } | null> {
  const rs = await client.execute(`SELECT "id", "name" FROM "organization" ORDER BY "createdAt", "id" LIMIT 1`);
  const row = rs.rows[0];
  return row ? { id: String(row.id), name: String(row.name) } : null;
}

/** The organization a new session starts in: the person's oldest membership. */
async function firstMembership(client: Client, userId: string): Promise<string | null> {
  const rs = await client.execute({
    sql: `SELECT "organizationId" FROM "member" WHERE "userId" = ? ORDER BY "createdAt", "id" LIMIT 1`,
    args: [userId],
  });
  const id = rs.rows[0]?.organizationId;
  return id === undefined || id === null ? null : String(id);
}

export interface ViewerOrganization {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

/** The organization a person works in: `active` when they belong to it, else their oldest membership. */
export async function organizationOf(
  client: Client,
  userId: string,
  active: string | null,
): Promise<ViewerOrganization | null> {
  const rs = await client.execute({
    sql: `SELECT o."id", o."name", o."slug", m."role" FROM "member" m JOIN "organization" o ON o."id" = m."organizationId"
          WHERE m."userId" = ? ORDER BY (o."id" = ?) DESC, m."createdAt", m."id" LIMIT 1`,
    args: [userId, active],
  });
  const row = rs.rows[0];
  if (!row) return null;
  const role = String(row.role);
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    role: isRole(role) ? role : "member",
  };
}

export function createAuth(settings: AuthSettings, { client, sender, now = () => new Date() }: AccountsDeps) {
  const owner = (email: string) => settings.owners.includes(email.trim().toLowerCase());
  const https = new URL(settings.baseUrl).protocol === "https:";
  return betterAuth({
    appName: "Armada",
    baseURL: settings.baseUrl,
    basePath: AUTH_API_PREFIX,
    secret: settings.secret,
    trustedOrigins: [settings.baseUrl],
    database: { dialect: new LibsqlDialect(client), type: "sqlite", transaction: true },
    telemetry: { enabled: false },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      // Session cookies are HttpOnly and SameSite=Lax; Secure everywhere but plain-http local development.
      useSecureCookies: settings.production || https,
    },
    session: {
      expiresIn: 30 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      // The Fleet view polls every few seconds: a signed cookie spares the
      // database a read per poll. A revoked session lasts at most this long.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    rateLimit: {
      storage: "database",
      // Anyone may ask for a code of `armada login` (/api/cli/device/code): ten a minute per address is plenty.
      customRules: { "/device/code": { window: 60, max: 10 } },
    },
    onAPIError: { errorURL: LOGIN_PATH },
    emailAndPassword: {
      enabled: settings.emailPassword,
      // No session before the address is proven: an owner or invited address
      // alone must not be enough to get in.
      requireEmailVerification: true,
      minPasswordLength: 12,
    },
    emailVerification: {
      sendOnSignUp: true,
      // Not on sign-in: a stranger signing in with someone's address must not produce fresh links.
      sendOnSignIn: false,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) =>
        sender.send({
          kind: "verification",
          to: user.email,
          subject: "Confirm your address for Armada",
          text: `Open this link to confirm ${user.email} and sign in to Armada:\n\n${url}\n\nIt expires in one hour.`,
          url,
        }),
    },
    socialProviders: settings.github
      ? { github: { clientId: settings.github.clientId, clientSecret: settings.github.clientSecret } }
      : {},
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            // An address is proven by GitHub (verified) or, for email and password, by its
            // confirmation link before any session. Any other unverified address proves
            // nothing: letting it in would squat the account of whoever owns that address.
            if (!user.emailVerified && ctx?.path !== "/sign-up/email")
              throw new APIError("FORBIDDEN", {
                code: "GITHUB_EMAIL_NOT_VERIFIED",
                message: "Verify this address on GitHub first: Armada only trusts verified addresses.",
              });
            if (owner(user.email) || (await hasPendingInvitation(client, user.email, now()))) return { data: user };
            throw new APIError("FORBIDDEN", {
              code: "NOT_INVITED",
              message: "Armada accounts are by invitation: ask an organization owner to invite this address.",
            });
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const active = await firstMembership(client, session.userId);
            return { data: { ...session, activeOrganizationId: active } };
          },
        },
      },
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: (user) => owner(user.email) && user.emailVerified,
        creatorRole: "owner",
        // The first organization owns the projects registered without one; deleting it would orphan them.
        disableOrganizationDeletion: true,
        invitationExpiresIn: 7 * 24 * 60 * 60,
        cancelPendingInvitationsOnReInvite: true,
        requireEmailVerificationOnInvitation: true,
        sendInvitationEmail: async ({ id, email, organization: org, inviter, role }) => {
          const url = invitationUrl(settings.baseUrl, id);
          await sender.send({
            kind: "invitation",
            to: email,
            subject: `Join ${org.name} on Armada`,
            text: `${inviter.user.name || inviter.user.email} invites you to ${org.name} on Armada as ${role}.\n\nSign in with this address, then accept:\n\n${url}\n\nThe invitation expires in 7 days.`,
            url,
          });
        },
      }),
      deviceAuthorization({
        verificationUri: DEVICE_PATH,
        // Only the Armada CLI asks for codes: a code from anything else is refused.
        validateClient: (id) => id === CLI_CLIENT_ID,
        expiresIn: "15m",
        interval: "5s",
      }),
      apiKey({
        // A key belongs to an organization, not to the person who created it: a
        // headless coordinator acts for the organization, and a key survives
        // its creator leaving. Better Auth lets only the organization's owners
        // create, list and revoke them.
        references: "organization",
        defaultPrefix: API_KEY_PREFIX,
        // The prefix and four characters more: enough to tell keys apart on the Organization page.
        startingCharactersConfig: { charactersLength: API_KEY_PREFIX.length + 4 },
        requireName: true,
        // A coordinator checks its key on every command; a daily cap would stop the fleet.
        rateLimit: { enabled: false },
      }),
      // Last: sets the cookies Better Auth returns when a server action calls it.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
