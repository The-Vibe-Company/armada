import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { acceptInvitation, createOrganization, rejectInvitation, signOut } from "@/app/auth-actions";
import { AuthCard } from "@/components/AuthCard";
import { isRole } from "@/lib/accounts";
import { requireAccounts, requireSession } from "@/lib/accounts-server";
import { accountsModeOf } from "@/lib/accounts-settings";
import { LANGUAGE_COOKIE, ORG_ERRORS, type OrgError, STRINGS } from "@/lib/i18n";
import { languageOf } from "@/lib/server";

// Signed in, in no organization yet: an owner address creates the first one;
// anyone else accepts an invitation, or waits for one.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.org.welcomeTitle} — Armada` };
}

type Params = Promise<{ error?: string | string[] }>;

export default async function Welcome({ searchParams }: { searchParams: Params }) {
  if (accountsModeOf(process.env).kind !== "accounts") notFound();
  const viewer = await requireSession();
  if (viewer.organization) redirect("/");
  const [{ auth, settings }, jar, params] = await Promise.all([requireAccounts(), cookies(), searchParams]);
  const t = STRINGS[languageOf(jar.get(LANGUAGE_COOKIE)?.value)];
  const canCreate = settings.owners.includes(viewer.user.email.toLowerCase()) && viewer.user.emailVerified;
  const invitations = viewer.user.emailVerified
    ? await auth.api.listUserInvitations({ headers: await headers() }).catch(() => [])
    : [];
  const pending = invitations.filter((i) => i.status === "pending" && new Date(i.expiresAt).getTime() > Date.now());
  const error =
    typeof params.error === "string" && (ORG_ERRORS as readonly string[]).includes(params.error)
      ? (params.error as OrgError)
      : null;

  return (
    <AuthCard
      brandSub={t.brandSub}
      kicker={viewer.user.email}
      heading={t.org.welcomeHeading(viewer.user.name || viewer.user.email)}
      lead={canCreate ? t.org.createLead : t.org.waitLead}
    >
      {error && (
        <p className="login-error" role="alert">
          {t.org.errors[error]}
        </p>
      )}
      {pending.length > 0 && (
        <section className="welcome-invitations" aria-labelledby="invitations-title">
          <h2 id="invitations-title" className="section-label">
            {t.org.invitationsForYou}
          </h2>
          <ul className="plain-list">
            {pending.map((i) => (
              <li key={i.id} className="invite-row">
                <span>{t.org.invitedTo(i.organizationName, t.org.roles[isRole(i.role) ? i.role : "member"])}</span>
                <span className="row-actions">
                  <form action={acceptInvitation}>
                    <input type="hidden" name="invitation" value={i.id} />
                    <button type="submit" className="btn is-primary">
                      {t.org.accept}
                    </button>
                  </form>
                  <form action={rejectInvitation}>
                    <input type="hidden" name="invitation" value={i.id} />
                    <button type="submit" className="btn">
                      {t.org.decline}
                    </button>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {canCreate && (
        <form action={createOrganization} className="login-form">
          <label htmlFor="org-name">{t.org.orgName}</label>
          <input id="org-name" name="name" required maxLength={60} autoComplete="organization" />
          <button type="submit">{t.org.create}</button>
        </form>
      )}
      <form action={signOut} className="login-switch">
        <button type="submit" className="link">
          {t.auth.logout}
        </button>
      </form>
    </AuthCard>
  );
}
