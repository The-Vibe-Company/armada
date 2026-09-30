import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import {
  cancelInvitation,
  inviteMember,
  removeMember,
  revokeApiKey,
  signOut,
  switchOrganization,
  updateMemberRole,
} from "@/app/auth-actions";
import { ApiKeyForm } from "@/components/ApiKeyForm";
import { AuthCard } from "@/components/AuthCard";
import { CopyLink } from "@/components/CopyLink";
import { invitationUrl, isRole, ROLES, type Role } from "@/lib/accounts";
import { requireAccounts, requireMember } from "@/lib/accounts-server";
import { accountsModeOf, KEYS_PATH, WORKERS_PATH } from "@/lib/accounts-settings";
import { LANGUAGE_COOKIE, ORG_ERRORS, ORG_NOTICES, type OrgError, type OrgNotice, STRINGS } from "@/lib/i18n";
import { languageOf } from "@/lib/server";

// The viewer's organization: its members, pending invitations and API keys.
// Owners and admins invite, change roles and remove; owners create and revoke
// the API keys of headless coordinators. Better Auth enforces who may do what.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.org.nav} — Armada` };
}

type Params = Promise<{ error?: string | string[]; done?: string | string[] }>;

const pick = <T extends string>(list: readonly T[], v: string | string[] | undefined): T | null =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;

export default async function Organization({ searchParams }: { searchParams: Params }) {
  if (accountsModeOf(process.env).kind !== "accounts") notFound();
  const viewer = await requireMember();
  const [{ auth, settings }, jar, params, h] = await Promise.all([
    requireAccounts(),
    cookies(),
    searchParams,
    headers(),
  ]);
  const lang = languageOf(jar.get(LANGUAGE_COOKIE)?.value);
  const t = STRINGS[lang];
  const [full, organizations] = await Promise.all([
    auth.api.getFullOrganization({ query: { organizationId: viewer.organization.id }, headers: h }),
    auth.api.listOrganizations({ headers: h }),
  ]);
  const manager = viewer.organization.role === "owner" || viewer.organization.role === "admin";
  const owner = viewer.organization.role === "owner";
  // Only owners may read the organization's keys; Better Auth refuses the others.
  const apiKeys = owner
    ? ((
        await auth.api
          .listApiKeys({ query: { organizationId: viewer.organization.id }, headers: h })
          .catch(() => ({ apiKeys: [] }))
      ).apiKeys ?? [])
    : [];
  // Only an owner hands out the owner role.
  const grantable: readonly Role[] = viewer.organization.role === "owner" ? ROLES : ROLES.filter((r) => r !== "owner");
  const error = pick<OrgError>(ORG_ERRORS, params.error);
  const done = pick<OrgNotice>(ORG_NOTICES, params.done);
  const date = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short" });
  const invitations = (full?.invitations ?? []).filter(
    (i) => i.status === "pending" && new Date(i.expiresAt).getTime() > Date.now(),
  );
  const roleOf = (r: string) => t.org.roles[isRole(r) ? r : "member"];

  return (
    <AuthCard wide brandSub={t.brandSub} kicker={t.org.nav} heading={viewer.organization.name} lead={t.org.roleHint}>
      {error && (
        <p className="login-error" role="alert">
          {t.org.errors[error]}
        </p>
      )}
      {done && (
        <p className="login-notice" role="status">
          {t.org.notices[done]}
        </p>
      )}

      <section className="org-section" aria-labelledby="members-title">
        <h2 id="members-title" className="section-label">
          {t.org.members} <span className="tnum faint">{full?.members.length ?? 0}</span>
        </h2>
        <ul className="plain-list">
          {(full?.members ?? []).map((m) => {
            const self = m.userId === viewer.user.id;
            return (
              <li key={m.id} className="member-row">
                <span className="member-who">
                  <b>{m.user.name || m.user.email}</b>
                  {self && <span className="tag">{t.org.you}</span>}
                  <span className="member-mail">{m.user.email}</span>
                </span>
                {manager && !self ? (
                  <span className="row-actions">
                    <form action={updateMemberRole} className="inline-form">
                      <input type="hidden" name="member" value={m.id} />
                      <label className="sr-only" htmlFor={`role-${m.id}`}>
                        {t.org.role}
                      </label>
                      <select id={`role-${m.id}`} name="role" defaultValue={m.role}>
                        {grantable.map((r) => (
                          <option key={r} value={r}>
                            {t.org.roles[r]}
                          </option>
                        ))}
                      </select>
                      <button type="submit" className="btn">
                        {t.org.changeRole}
                      </button>
                    </form>
                    <form action={removeMember}>
                      <input type="hidden" name="member" value={m.id} />
                      <button type="submit" className="btn is-danger">
                        {t.org.remove}
                      </button>
                    </form>
                  </span>
                ) : (
                  <span className="role-tag">{roleOf(m.role)}</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="org-section" aria-labelledby="invitations-title">
        <h2 id="invitations-title" className="section-label">
          {t.org.invitations} <span className="tnum faint">{invitations.length}</span>
        </h2>
        {invitations.length === 0 ? (
          <p className="faint">{t.org.noInvitations}</p>
        ) : (
          <ul className="plain-list">
            {invitations.map((i) => (
              <li key={i.id} className="member-row">
                <span className="member-who">
                  <b>{i.email}</b>
                  <span className="member-mail">
                    {roleOf(i.role ?? "member")} · {t.org.expires(date.format(new Date(i.expiresAt)))}
                  </span>
                </span>
                {manager && (
                  <span className="row-actions">
                    <CopyLink url={invitationUrl(settings.baseUrl, i.id)} label={t.org.copyLink} done={t.org.copied} />
                    <form action={cancelInvitation}>
                      <input type="hidden" name="invitation" value={i.id} />
                      <button type="submit" className="btn">
                        {t.org.cancel}
                      </button>
                    </form>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {manager ? (
        <section className="org-section" aria-labelledby="invite-title">
          <h2 id="invite-title" className="section-label">
            {t.org.invite}
          </h2>
          <form action={inviteMember} className="invite-form">
            <label className="sr-only" htmlFor="invite-email">
              {t.org.inviteEmail}
            </label>
            <input id="invite-email" name="email" type="email" required placeholder={t.org.inviteEmail} />
            <label className="sr-only" htmlFor="invite-role">
              {t.org.role}
            </label>
            <select id="invite-role" name="role" defaultValue="member">
              {grantable.map((r) => (
                <option key={r} value={r}>
                  {t.org.roles[r]}
                </option>
              ))}
            </select>
            <button type="submit" className="btn is-primary">
              {t.org.sendInvite}
            </button>
          </form>
          <p className="login-hint">{t.org.emailNote}</p>
        </section>
      ) : (
        <p className="login-hint">{t.org.onlyAdmins}</p>
      )}

      <section className="org-section" aria-labelledby="api-keys-title">
        <h2 id="api-keys-title" className="section-label">
          {t.org.apiKeys} {owner && <span className="tnum faint">{apiKeys.length}</span>}
        </h2>
        <p className="login-hint is-top">{t.org.apiKeysHint}</p>
        {owner ? (
          <>
            {apiKeys.length === 0 ? (
              <p className="faint">{t.org.noApiKeys}</p>
            ) : (
              <ul className="plain-list">
                {apiKeys.map((k) => (
                  <li key={k.id} className="member-row">
                    <span className="member-who">
                      <b>{k.name ?? k.start ?? k.id}</b>
                      <span className="member-mail mono">{k.start ? `${k.start}…` : ""}</span>
                      <span className="member-mail">
                        {t.org.keyCreated(date.format(new Date(k.createdAt)))} ·{" "}
                        {k.lastRequest ? t.org.keyUsed(date.format(new Date(k.lastRequest))) : t.org.keyUnused}
                      </span>
                    </span>
                    <form action={revokeApiKey}>
                      <input type="hidden" name="key" value={k.id} />
                      <button type="submit" className="btn is-danger">
                        {t.org.revoke}
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <ApiKeyForm lang={lang} />
          </>
        ) : (
          <p className="login-hint">{t.org.onlyOwners}</p>
        )}
      </section>

      <section className="org-section" aria-labelledby="keys-title">
        <h2 id="keys-title" className="section-label">
          {t.keys.nav}
        </h2>
        <a className="link" href={KEYS_PATH}>
          {t.org.keysLink} →
        </a>
      </section>

      <section className="org-section" aria-labelledby="workers-title">
        <h2 id="workers-title" className="section-label">
          {t.workers.nav}
        </h2>
        <a className="link" href={WORKERS_PATH}>
          {t.org.workersLink} →
        </a>
      </section>

      {organizations.length > 1 && (
        <section className="org-section" aria-labelledby="orgs-title">
          <h2 id="orgs-title" className="section-label">
            {t.org.yourOrganizations}
          </h2>
          <ul className="plain-list">
            {organizations.map((o) => (
              <li key={o.id} className="member-row">
                <b>{o.name}</b>
                {o.id === viewer.organization.id ? (
                  <span className="role-tag">{t.org.current}</span>
                ) : (
                  <form action={switchOrganization}>
                    <input type="hidden" name="organization" value={o.id} />
                    <button type="submit" className="btn">
                      {t.org.switchTo}
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="org-foot">
        <a className="link" href="/">
          ← {t.org.back}
        </a>
        <form action={signOut}>
          <button type="submit" className="link">
            {t.auth.logout}
          </button>
        </form>
      </div>
    </AuthCard>
  );
}
