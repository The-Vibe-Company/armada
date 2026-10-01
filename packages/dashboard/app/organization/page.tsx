import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import {
  cancelInvitation,
  inviteMember,
  removeMember,
  revokeApiKey,
  switchOrganization,
  updateMemberRole,
} from "@/app/auth-actions";
import { ApiKeyForm } from "@/components/ApiKeyForm";
import { CopyLink } from "@/components/CopyLink";
import { Notice, Page, Row, RowSide, RowText, Section, SectionBody } from "@/components/page";
import { Tag } from "@/components/ui";
import { invitationUrl, isRole, ROLES, type Role } from "@/lib/accounts";
import { requireAccounts, requireMember } from "@/lib/accounts-server";
import { accountsModeOf, GITHUB_PATH, KEYS_PATH, WORKERS_PATH } from "@/lib/accounts-settings";
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
    <Page>
      {error && <Notice tone="critical">{t.org.errors[error]}</Notice>}
      {done && <Notice tone="done">{t.org.notices[done]}</Notice>}

      <Section label={t.org.members} count={full?.members.length ?? 0} side={viewer.organization.name}>
        <SectionBody>
          <p>{t.org.roleHint}</p>
        </SectionBody>
        {(full?.members ?? []).map((m) => {
          const self = m.userId === viewer.user.id;
          return (
            <Row key={m.id}>
              <RowText
                title={
                  <>
                    {m.user.name || m.user.email} {self && <Tag>{t.org.you}</Tag>}
                  </>
                }
                line={m.user.email}
              />
              {manager && !self ? (
                <RowSide>
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
                </RowSide>
              ) : (
                <RowSide>
                  <Tag>{roleOf(m.role)}</Tag>
                </RowSide>
              )}
            </Row>
          );
        })}
      </Section>

      <Section label={t.org.invitations} count={invitations.length}>
        {invitations.length === 0 ? (
          <SectionBody>
            <p className="faint">{t.org.noInvitations}</p>
          </SectionBody>
        ) : (
          invitations.map((i) => (
            <Row key={i.id}>
              <RowText
                title={i.email}
                line={`${roleOf(i.role ?? "member")} · ${t.org.expires(date.format(new Date(i.expiresAt)))}`}
              />
              {manager && (
                <RowSide>
                  <CopyLink url={invitationUrl(settings.baseUrl, i.id)} label={t.org.copyLink} done={t.org.copied} />
                  <form action={cancelInvitation}>
                    <input type="hidden" name="invitation" value={i.id} />
                    <button type="submit" className="btn">
                      {t.org.cancel}
                    </button>
                  </form>
                </RowSide>
              )}
            </Row>
          ))
        )}
      </Section>

      <Section label={t.org.invite}>
        <SectionBody>
          {manager ? (
            <>
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
              <p className="faint">{t.org.emailNote}</p>
            </>
          ) : (
            <p className="faint">{t.org.onlyAdmins}</p>
          )}
        </SectionBody>
      </Section>

      <Section label={t.org.apiKeys} count={owner ? apiKeys.length : undefined}>
        <SectionBody>
          <p>{t.org.apiKeysHint}</p>
          {!owner && <p className="faint">{t.org.onlyOwners}</p>}
          {owner && apiKeys.length === 0 && <p className="faint">{t.org.noApiKeys}</p>}
        </SectionBody>
        {owner &&
          apiKeys.map((k) => (
            <Row key={k.id}>
              <RowText
                title={k.name ?? k.start ?? k.id}
                line={
                  <>
                    {k.start && <span className="mono">{k.start}… · </span>}
                    {t.org.keyCreated(date.format(new Date(k.createdAt)))} ·{" "}
                    {k.lastRequest ? t.org.keyUsed(date.format(new Date(k.lastRequest))) : t.org.keyUnused}
                  </>
                }
              />
              <RowSide>
                <form action={revokeApiKey}>
                  <input type="hidden" name="key" value={k.id} />
                  <button type="submit" className="btn is-danger">
                    {t.org.revoke}
                  </button>
                </form>
              </RowSide>
            </Row>
          ))}
        {owner && (
          <SectionBody>
            <ApiKeyForm lang={lang} />
          </SectionBody>
        )}
      </Section>

      <Section label={t.shell.settings}>
        <Row href={KEYS_PATH}>
          <RowText title={t.keys.nav} line={t.org.keysLink} />
          <RowSide>→</RowSide>
        </Row>
        <Row href={GITHUB_PATH}>
          <RowText title={t.github.nav} line={t.org.githubLink} />
          <RowSide>→</RowSide>
        </Row>
        <Row href={WORKERS_PATH}>
          <RowText title={t.workers.nav} line={t.org.workersLink} />
          <RowSide>→</RowSide>
        </Row>
      </Section>

      {organizations.length > 1 && (
        <Section label={t.org.yourOrganizations} count={organizations.length}>
          {organizations.map((o) => (
            <Row key={o.id}>
              <RowText title={o.name} />
              <RowSide>
                {o.id === viewer.organization.id ? (
                  <Tag>{t.org.current}</Tag>
                ) : (
                  <form action={switchOrganization}>
                    <input type="hidden" name="organization" value={o.id} />
                    <button type="submit" className="btn">
                      {t.org.switchTo}
                    </button>
                  </form>
                )}
              </RowSide>
            </Row>
          ))}
        </Section>
      )}
    </Page>
  );
}
