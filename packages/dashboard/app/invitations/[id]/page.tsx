import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { acceptInvitation, rejectInvitation, signOut } from "@/app/auth-actions";
import { AuthCard } from "@/components/AuthCard";
import { isRole } from "@/lib/accounts";
import { requireAccounts, requireSession } from "@/lib/accounts-server";
import { accountsModeOf } from "@/lib/accounts-settings";
import { LANGUAGE_COOKIE, ORG_ERRORS, type OrgError, STRINGS } from "@/lib/i18n";
import { languageOf } from "@/lib/server";

// The link of an invitation email. The proxy sends a viewer without a session
// to the sign-in page first and back here after; Better Auth only shows the
// invitation to the address it was sent to.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.org.invitationTitle} — Armada` };
}

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string | string[] }> };

export default async function Invitation({ params, searchParams }: Props) {
  if (accountsModeOf(process.env).kind !== "accounts") notFound();
  const viewer = await requireSession();
  const [{ auth }, jar, { id }, query] = await Promise.all([requireAccounts(), cookies(), params, searchParams]);
  const t = STRINGS[languageOf(jar.get(LANGUAGE_COOKIE)?.value)];
  const invitation = await auth.api.getInvitation({ query: { id }, headers: await headers() }).catch(() => null);
  const error =
    typeof query.error === "string" && (ORG_ERRORS as readonly string[]).includes(query.error)
      ? (query.error as OrgError)
      : null;

  if (invitation?.status !== "pending") {
    // Better Auth refuses to show an invitation to another address: say which one is signed in.
    return (
      <AuthCard
        brandSub={t.brandSub}
        kicker={t.org.invitationTitle}
        heading={t.org.invitationTitle}
        lead={t.org.invitationGone}
      >
        <p className="login-hint">{t.org.signedInAs(viewer.user.email)}</p>
        <p className="login-switch">
          <Link className="link" href="/">
            {t.org.back}
          </Link>
        </p>
        <form action={signOut} className="login-switch">
          <button type="submit" className="link">
            {t.auth.logout}
          </button>
        </form>
      </AuthCard>
    );
  }

  const role = t.org.roles[isRole(invitation.role) ? invitation.role : "member"];
  return (
    <AuthCard
      brandSub={t.brandSub}
      kicker={t.org.invitationTitle}
      heading={t.org.invitationHeading(invitation.organizationName)}
      lead={t.org.invitationLead(invitation.inviterEmail, role)}
    >
      {error && (
        <p className="login-error" role="alert">
          {t.org.errors[error]}
        </p>
      )}
      <div className="row-actions is-spread">
        <form action={acceptInvitation} className="login-form is-grow">
          <input type="hidden" name="invitation" value={invitation.id} />
          <button type="submit">{t.org.accept}</button>
        </form>
        <form action={rejectInvitation}>
          <input type="hidden" name="invitation" value={invitation.id} />
          <button type="submit" className="btn">
            {t.org.decline}
          </button>
        </form>
      </div>
      <p className="login-hint">{viewer.user.email}</p>
    </AuthCard>
  );
}
