import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { revokeApiKey } from "@/app/auth-actions";
import { deleteKey, saveKey } from "@/app/keys-actions";
import { ApiKeyForm } from "@/components/ApiKeyForm";
import { Disclose, OrgBar, OrgHeading, OrgNone, OrgPage, OrgRow, OrgRows } from "@/components/org";
import { Button, Form, Input, Notice } from "@/components/page";
import { requireAccounts, requireMember } from "@/lib/accounts-server";
import { accountsModeOf, KEYS_PATH } from "@/lib/accounts-settings";
import { projectsOf } from "@/lib/fleet-store";
import {
  KEYS_ERRORS,
  KEYS_NOTICES,
  type KeyLabel,
  type KeysError,
  type KeysNotice,
  LANGUAGE_COOKIE,
  ORG_ERRORS,
  ORG_NOTICES,
  type OrgError,
  type OrgNotice,
  STRINGS,
} from "@/lib/i18n";
import { languageOf } from "@/lib/server";
import {
  isWorkerSecretName,
  listEvents,
  listSecrets,
  SECRET_KINDS,
  SECRETS_KEY_VARIABLE,
  type SecretInfo,
  type SecretName,
  vaultModeOf,
} from "@/lib/vault";

// The organization's access (THE-1021 on design/dashboard-v7): its API keys
// (headless coordinators sign in with them; owners create and revoke them),
// then the keys Armada keeps in its vault (THE-840) and each project's
// (THE-859), one scope at a time (`?project=<slug>`): the Linear and GitHub
// keys, the secrets for workers, and the audit list. Owners and admins set,
// replace and delete them; every member sets their own Linear key. A
// secret's value never reaches this page: only who set it and when.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.keys.nav} — Armada` };
}

type Params = Promise<{ error?: string | string[]; done?: string | string[]; project?: string | string[] }>;

const pick = <T extends string>(list: readonly T[], v: string | string[] | undefined): T | null =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;

const SLOTS: SecretName[] = ["linear-api-key", "github-token"];

export default async function Keys({ searchParams }: { searchParams: Params }) {
  if (accountsModeOf(process.env).kind !== "accounts") notFound();
  const viewer = await requireMember();
  const [{ auth, client }, jar, params, h] = await Promise.all([requireAccounts(), cookies(), searchParams, headers()]);
  const lang = languageOf(jar.get(LANGUAGE_COOKIE)?.value);
  const t = STRINGS[lang];
  const k = t.keys;
  const o = t.org;
  const vault = vaultModeOf(process.env);
  const owner = viewer.organization.role === "owner";
  const manager = owner || viewer.organization.role === "admin";
  const error = pick<KeysError>(KEYS_ERRORS, params.error);
  const done = pick<KeysNotice>(KEYS_NOTICES, params.done);
  // The API key forms come back with the members' page's codes.
  const orgError = pick<OrgError>(ORG_ERRORS, params.error);
  const orgDone = pick<OrgNotice>(ORG_NOTICES, params.done);
  const day = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short" });
  const date = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const when = (iso: string) => date.format(new Date(iso));
  // Only owners may read the organization's API keys; Better Auth refuses the others.
  const apiKeys = owner
    ? ((
        await auth.api
          .listApiKeys({ query: { organizationId: viewer.organization.id }, headers: h })
          .catch(() => ({ apiKeys: [] }))
      ).apiKeys ?? [])
    : [];

  const apiKeysList = (
    <>
      <OrgBar hint={owner ? o.apiKeysHint : `${o.apiKeysHint} ${o.onlyOwners}`}>
        {owner && (
          <Disclose label={o.newKey} primary>
            <ApiKeyForm lang={lang} />
          </Disclose>
        )}
      </OrgBar>
      {owner && (
        <OrgRows>
          {apiKeys.length === 0 && <OrgNone>{o.noApiKeys}</OrgNone>}
          {apiKeys.map((key) => (
            <OrgRow
              key={key.id}
              a={key.name ?? key.start ?? key.id}
              sub={key.start ? `${key.start}…` : undefined}
              subMono
              b={o.keyCreated(day.format(new Date(key.createdAt)))}
              c={key.lastRequest ? o.keyUsed(day.format(new Date(key.lastRequest))) : o.keyUnused}
              color={key.lastRequest ? undefined : "var(--amber)"}
              d={
                <Form action={revokeApiKey}>
                  <input type="hidden" name="key" value={key.id} />
                  <button type="submit" className="org-link">
                    {o.revoke}
                  </button>
                </Form>
              }
            />
          ))}
        </OrgRows>
      )}
    </>
  );

  if (vault.kind !== "on")
    return (
      <OrgPage t={t} name={viewer.organization.name} page="keys">
        {orgError && <Notice tone="critical">{o.errors[orgError]}</Notice>}
        {orgDone && <Notice tone="done">{o.notices[orgDone]}</Notice>}
        {apiKeysList}
        <OrgHeading>{k.vault}</OrgHeading>
        <Notice tone="critical">
          {vault.kind === "off" ? k.vaultOff(SECRETS_KEY_VARIABLE) : k.vaultInvalid(SECRETS_KEY_VARIABLE)}
        </Notice>
      </OrgPage>
    );

  const projects = await projectsOf(client, viewer.organization.id);
  const project = projects.find((p) => p.slug === params.project) ?? null;
  const slug = project?.slug ?? "";
  const [secrets, inherited, events] = await Promise.all([
    listSecrets(client, vault.key, { organization: viewer.organization.id, user: viewer.user.id, project: slug }),
    // In a project, the organization's secrets for workers it also gets.
    project ? listSecrets(client, null, { organization: viewer.organization.id, user: viewer.user.id }) : [],
    manager ? listEvents(client, viewer.organization.id, 50, project ? slug : null) : [],
  ]);
  const find = (name: string, own: boolean) => secrets.find((s) => s.name === name && s.own === own) ?? null;
  const workerSecrets = secrets.filter((s) => isWorkerSecretName(s.name));
  const fromOrganization = inherited
    .filter((s) => isWorkerSecretName(s.name) && !workerSecrets.some((w) => w.name === s.name))
    .map((s) => s.name);
  const setBy = (info: SecretInfo) =>
    `${k.setBy(info.setBy, when(info.setAt))}${info.readable ? "" : ` · ${k.unreadable}`}`;

  /** The hidden fields that say which slot a form is for. */
  const slotFields = (name: string, scope: "own" | "organization" | "project") => (
    <>
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="scope" value={scope} />
      {scope === "project" && <input type="hidden" name="project" value={slug} />}
    </>
  );
  /** Set or replace a slot's value, and delete it when it is set. */
  const editor = (id: string, label: string, name: string, scope: "own" | "organization" | "project", set: boolean) => {
    const secret = isWorkerSecretName(name) || SECRET_KINDS[name as SecretName]?.secret !== false;
    return (
      <Disclose label={o.manage}>
        <Form action={saveKey}>
          {slotFields(name, scope)}
          <label className="sr-only" htmlFor={id}>
            {`${label}: ${k.newValue}`}
          </label>
          <Input
            id={id}
            name="value"
            type={secret ? "password" : "text"}
            required
            autoComplete={secret ? "new-password" : "off"}
            spellCheck={false}
            placeholder={k.newValue}
            maxLength={32768}
          />
          <Button tone="primary">{set ? k.replace : k.save}</Button>
        </Form>
        {set && (
          <Form action={deleteKey}>
            {slotFields(name, scope)}
            <Button tone="danger">{k.remove}</Button>
          </Form>
        )}
      </Disclose>
    );
  };

  const slot = (name: SecretName, own: boolean) => {
    const label: KeyLabel = own ? "own-linear-api-key" : project ? "project-linear-api-key" : name;
    const scope = own ? "own" : project ? "project" : "organization";
    const info = find(name, own);
    return (
      <OrgRow
        key={label}
        a={k.labels[label]}
        sub={info?.value ?? k.hints[label]}
        subMono={!!info?.value}
        b={info ? setBy(info) : null}
        c={info ? k.isSet : k.notSet}
        color={info ? "var(--green)" : "var(--text-3)"}
        d={(own || manager) && editor(`slot-${label}`, k.labels[label], name, scope, !!info)}
      />
    );
  };
  const secretScope = project ? "project" : "organization";
  const scopeHref = (p: string) => (p ? `${KEYS_PATH}?${new URLSearchParams({ project: p })}` : KEYS_PATH);

  return (
    <OrgPage t={t} name={viewer.organization.name} page="keys">
      {orgError && <Notice tone="critical">{o.errors[orgError]}</Notice>}
      {orgDone && <Notice tone="done">{o.notices[orgDone]}</Notice>}
      {error && <Notice tone="critical">{k.errors[error]}</Notice>}
      {done && <Notice tone="done">{k.notices[done]}</Notice>}
      {apiKeysList}

      <OrgHeading
        side={
          projects.length > 0 && (
            <nav className="ov-chips" aria-label={k.scope}>
              {[{ slug: "", name: k.organizationScope }, ...projects].map((p) => (
                <Link
                  key={p.slug}
                  href={scopeHref(p.slug)}
                  className="ov-chip"
                  aria-current={p.slug === slug ? "true" : undefined}
                >
                  {p.name}
                </Link>
              ))}
            </nav>
          )
        }
      >
        {k.vault}
      </OrgHeading>
      <OrgBar hint={`${project ? k.projectLead(project.name) : k.lead}${manager ? "" : ` ${k.onlyAdmins}`}`} />
      <OrgRows>
        {(project ? SLOTS.filter((n) => n === "linear-api-key") : SLOTS).map((n) => slot(n, false))}
        {!project && slot("linear-api-key", true)}
      </OrgRows>

      <OrgHeading>{k.workerSecrets}</OrgHeading>
      <OrgBar
        hint={
          <>
            {k.workerSecretsHint(!project)}
            {fromOrganization.length > 0 && (
              <span className="mono"> {k.fromOrganization(fromOrganization.join(", "))}</span>
            )}
          </>
        }
      >
        {manager && (
          <Disclose label={k.add} primary>
            <Form action={saveKey} grow>
              <input type="hidden" name="scope" value={secretScope} />
              {project && <input type="hidden" name="project" value={slug} />}
              <label className="sr-only" htmlFor="secret-name">
                {k.secretName}
              </label>
              <Input
                id="secret-name"
                name="name"
                type="text"
                required
                autoComplete="off"
                spellCheck={false}
                pattern="[A-Za-z][A-Za-z0-9_]{0,63}"
                placeholder={k.secretNamePlaceholder}
                maxLength={64}
                className="mono"
              />
              <label className="sr-only" htmlFor="secret-value">
                {k.newValue}
              </label>
              <Input
                id="secret-value"
                name="value"
                type="password"
                required
                autoComplete="new-password"
                spellCheck={false}
                placeholder={k.newValue}
                maxLength={32768}
              />
              <Button tone="primary">{k.add}</Button>
            </Form>
          </Disclose>
        )}
      </OrgBar>
      <OrgRows>
        {workerSecrets.length === 0 && <OrgNone>{k.noSecrets}</OrgNone>}
        {workerSecrets.map((info) => (
          <OrgRow
            key={info.name}
            a={<span className="mono">{info.name}</span>}
            b={setBy(info)}
            c={k.isSet}
            color="var(--green)"
            d={manager && editor(`secret-${info.name}`, info.name, info.name, secretScope, true)}
          />
        ))}
      </OrgRows>

      {manager && (
        <>
          <OrgHeading>{k.audit}</OrgHeading>
          <OrgBar hint={`${k.auditHint}${project ? ` ${k.auditProjectHint(project.name)}` : ""}`} />
          <OrgRows>
            {events.length === 0 && <OrgNone>{k.noEvents}</OrgNone>}
            {events.map((e) => (
              <OrgRow
                key={e.id}
                a={e.actor.label}
                sub={e.keys.length ? e.keys.join(", ") : k.nothing}
                subMono
                b={[!project && e.project, e.detail].filter(Boolean).join(" · ")}
                c={k.actions[e.action]}
                color={e.action === "refuse" ? "var(--red)" : undefined}
                d={<span className="org-when">{when(e.at)}</span>}
              />
            ))}
          </OrgRows>
        </>
      )}
    </OrgPage>
  );
}
