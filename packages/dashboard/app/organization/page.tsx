import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { cancelInvitation, inviteMember, removeMember, updateMemberRole } from "@/app/auth-actions";
import { CopyLink } from "@/components/CopyLink";
import { Disclose, OrgBar, OrgPage, OrgRow, OrgRows } from "@/components/org";
import { Button, Form, Input, Notice, Select } from "@/components/page";
import { invitationUrl, isRole, ROLES, type Role } from "@/lib/accounts";
import { requireAccounts, requireMember } from "@/lib/accounts-server";
import { accountsModeOf } from "@/lib/accounts-settings";
import { LANGUAGE_COOKIE, ORG_ERRORS, ORG_NOTICES, type OrgError, type OrgNotice, STRINGS } from "@/lib/i18n";
import { languageOf } from "@/lib/server";

// The organization's members and pending invitations (THE-1021 on
// design/dashboard-v7). Owners and admins invite, change roles and remove;
// Better Auth enforces who may do what. The API keys are the next tab.
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
  const o = t.org;
  const full = await auth.api.getFullOrganization({ query: { organizationId: viewer.organization.id }, headers: h });
  const manager = viewer.organization.role === "owner" || viewer.organization.role === "admin";
  // Only an owner hands out the owner role.
  const grantable: readonly Role[] = viewer.organization.role === "owner" ? ROLES : ROLES.filter((r) => r !== "owner");
  const error = pick<OrgError>(ORG_ERRORS, params.error);
  const done = pick<OrgNotice>(ORG_NOTICES, params.done);
  const date = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short" });
  const members = full?.members ?? [];
  const invitations = (full?.invitations ?? []).filter(
    (i) => i.status === "pending" && new Date(i.expiresAt).getTime() > Date.now(),
  );
  const roleOf = (r: string) => o.roles[isRole(r) ? r : "member"];
  const roles = (id: string, value: string) => (
    <>
      <label className="sr-only" htmlFor={id}>
        {o.role}
      </label>
      <Select id={id} name="role" defaultValue={value}>
        {grantable.map((r) => (
          <option key={r} value={r}>
            {o.roles[r]}
          </option>
        ))}
      </Select>
    </>
  );

  return (
    <OrgPage t={t} name={viewer.organization.name} page="members">
      {error && <Notice tone="critical">{o.errors[error]}</Notice>}
      {done && <Notice tone="done">{o.notices[done]}</Notice>}
      <OrgBar hint={manager ? o.membersHint(members.length) : `${o.membersHint(members.length)} ${o.onlyAdmins}`}>
        {manager && (
          <Disclose label={o.sendInvite} primary>
            <Form action={inviteMember} grow>
              <label className="sr-only" htmlFor="invite-email">
                {o.inviteEmail}
              </label>
              <Input id="invite-email" name="email" type="email" required placeholder={o.inviteEmail} />
              {roles("invite-role", "member")}
              <Button tone="primary">{o.sendInvite}</Button>
            </Form>
            <p className="org-note">{o.emailNote}</p>
          </Disclose>
        )}
      </OrgBar>
      <OrgRows>
        {members.map((m) => {
          const self = m.userId === viewer.user.id;
          return (
            <OrgRow
              key={m.id}
              a={self ? `${m.user.name || m.user.email} (${o.you})` : m.user.name || m.user.email}
              sub={m.user.email}
              b={o.memberSince(date.format(new Date(m.createdAt)))}
              c={roleOf(m.role)}
              d={
                manager &&
                !self && (
                  <Disclose label={o.manage}>
                    <Form action={updateMemberRole}>
                      <input type="hidden" name="member" value={m.id} />
                      {roles(`role-${m.id}`, m.role)}
                      <Button>{o.changeRole}</Button>
                    </Form>
                    <Form action={removeMember}>
                      <input type="hidden" name="member" value={m.id} />
                      <Button tone="danger">{o.remove}</Button>
                    </Form>
                  </Disclose>
                )
              }
            />
          );
        })}
        {invitations.map((i) => (
          <OrgRow
            key={i.id}
            a={i.email}
            sub={roleOf(i.role ?? "member")}
            b={o.expires(date.format(new Date(i.expiresAt)))}
            c={o.pending}
            color="var(--amber)"
            d={
              manager && (
                <Disclose label={o.manage}>
                  <CopyLink url={invitationUrl(settings.baseUrl, i.id)} label={o.copyLink} done={o.copied} />
                  <Form action={cancelInvitation}>
                    <input type="hidden" name="invitation" value={i.id} />
                    <Button tone="danger">{o.cancel}</Button>
                  </Form>
                </Disclose>
              )
            }
          />
        ))}
      </OrgRows>
    </OrgPage>
  );
}
