import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteKey, saveKey } from "@/app/keys-actions";
import { AuthCard } from "@/components/AuthCard";
import { requireAccounts, requireMember } from "@/lib/accounts-server";
import { accountsModeOf, KEYS_PATH, ORGANIZATION_PATH } from "@/lib/accounts-settings";
import { projectsOf } from "@/lib/fleet-store";
import {
  KEYS_ERRORS,
  KEYS_NOTICES,
  type KeyLabel,
  type KeysError,
  type KeysNotice,
  LANGUAGE_COOKIE,
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

// The organization's keys (THE-840) and each project's (THE-859), one scope
// at a time: "Organization" or a project (`?project=<slug>`). Owners and
// admins set, replace and delete them, and the secrets for workers; every
// member sets their own Linear key. A secret's value never reaches this page:
// only who set it and when (`listSecrets` returns no secret value). Owners
// and admins read the audit list, filtered by the project picked.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.keys.nav} — Armada` };
}

type Params = Promise<{ error?: string | string[]; done?: string | string[]; project?: string | string[] }>;

const pick = <T extends string>(list: readonly T[], v: string | string[] | undefined): T | null =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;

const GROUPS: { title: "linear" | "github"; keys: SecretName[] }[] = [
  { title: "linear", keys: ["linear-api-key"] },
  { title: "github", keys: ["github-token"] },
];

export default async function Keys({ searchParams }: { searchParams: Params }) {
  if (accountsModeOf(process.env).kind !== "accounts") notFound();
  const viewer = await requireMember();
  const [{ client }, jar, params] = await Promise.all([requireAccounts(), cookies(), searchParams]);
  const lang = languageOf(jar.get(LANGUAGE_COOKIE)?.value);
  const t = STRINGS[lang];
  const k = t.keys;
  const vault = vaultModeOf(process.env);
  const manager = viewer.organization.role === "owner" || viewer.organization.role === "admin";
  const error = pick<KeysError>(KEYS_ERRORS, params.error);
  const done = pick<KeysNotice>(KEYS_NOTICES, params.done);
  const date = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const when = (iso: string) => date.format(new Date(iso));

  const foot = (
    <div className="org-foot">
      <a className="link" href={ORGANIZATION_PATH}>
        ← {t.org.nav}
      </a>
      <Link className="link" href="/">
        {t.org.back}
      </Link>
    </div>
  );
  if (vault.kind !== "on")
    return (
      <AuthCard wide brandSub={t.brandSub} kicker={k.nav} heading={viewer.organization.name} lead={k.lead}>
        <p className="login-error" role="alert">
          {vault.kind === "off" ? k.vaultOff(SECRETS_KEY_VARIABLE) : k.vaultInvalid(SECRETS_KEY_VARIABLE)}
        </p>
        {foot}
      </AuthCard>
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
  const status = (info: SecretInfo | null) =>
    info ? `${k.setBy(info.setBy, when(info.setAt))}${info.readable ? "" : ` · ${k.unreadable}`}` : k.notSet;

  /** The hidden fields that say which slot a form is for. */
  const slotFields = (name: string, scope: "own" | "organization" | "project") => (
    <>
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="scope" value={scope} />
      {scope === "project" && <input type="hidden" name="project" value={slug} />}
    </>
  );

  const row = (name: SecretName, own: boolean) => {
    const label: KeyLabel = own ? "own-linear-api-key" : project ? "project-linear-api-key" : name;
    const scope = own ? "own" : project ? "project" : "organization";
    const info: SecretInfo | null = find(name, own);
    const editable = own || manager;
    const secret = SECRET_KINDS[name].secret;
    const id = `key-${label}`;
    return (
      <li key={label} className="key-row">
        <span className="member-who">
          <b>{k.labels[label]}</b>
          <span className="member-mail">{status(info)}</span>
        </span>
        <span className="member-mail">{k.hints[label]}</span>
        {info?.value && <code className="mono key-value">{info.value}</code>}
        {editable && (
          <span className="row-actions is-key">
            <form action={saveKey} className="invite-form">
              {slotFields(name, scope)}
              <label className="sr-only" htmlFor={id}>
                {`${k.labels[label]}: ${k.newValue}`}
              </label>
              <input
                id={id}
                name="value"
                type={secret ? "password" : "text"}
                required
                autoComplete={secret ? "new-password" : "off"}
                spellCheck={false}
                placeholder={k.newValue}
                maxLength={4096}
              />
              <button type="submit" className="btn is-primary">
                {info ? k.replace : k.save}
              </button>
            </form>
            {info && (
              <form action={deleteKey}>
                {slotFields(name, scope)}
                <button type="submit" className="btn is-danger">
                  {k.remove}
                </button>
              </form>
            )}
          </span>
        )}
      </li>
    );
  };

  const secretScope = project ? "project" : "organization";
  const workerRow = (info: SecretInfo) => {
    const id = `secret-${info.name}`;
    return (
      <li key={info.name} className="key-row">
        <span className="member-who">
          <b className="mono">{info.name}</b>
          <span className="member-mail">{status(info)}</span>
        </span>
        {manager && (
          <span className="row-actions is-key">
            <form action={saveKey} className="invite-form">
              {slotFields(info.name, secretScope)}
              <label className="sr-only" htmlFor={id}>
                {`${info.name}: ${k.newValue}`}
              </label>
              <input
                id={id}
                name="value"
                type="password"
                required
                autoComplete="new-password"
                spellCheck={false}
                placeholder={k.newValue}
                maxLength={32768}
              />
              <button type="submit" className="btn is-primary">
                {k.replace}
              </button>
            </form>
            <form action={deleteKey}>
              {slotFields(info.name, secretScope)}
              <button type="submit" className="btn is-danger">
                {k.remove}
              </button>
            </form>
          </span>
        )}
      </li>
    );
  };

  const groups = project ? GROUPS.filter((g) => g.title === "linear") : GROUPS;
  const scopeHref = (p: string) => (p ? `${KEYS_PATH}?${new URLSearchParams({ project: p })}` : KEYS_PATH);

  return (
    <AuthCard wide brandSub={t.brandSub} kicker={k.nav} heading={viewer.organization.name} lead={k.lead}>
      {error && (
        <p className="login-error" role="alert">
          {k.errors[error]}
        </p>
      )}
      {done && (
        <p className="login-notice" role="status">
          {k.notices[done]}
        </p>
      )}
      {!manager && <p className="login-hint is-top">{k.onlyAdmins}</p>}

      {projects.length > 0 && (
        <nav className="org-section" aria-label={k.scope}>
          <h2 className="section-label">{k.scope}</h2>
          <ul className="chips">
            {[{ slug: "", name: k.organizationScope }, ...projects].map((p) => (
              <li key={p.slug || "organization"}>
                <Link
                  className="chip is-scope"
                  href={scopeHref(p.slug)}
                  aria-current={p.slug === slug ? "page" : undefined}
                >
                  {p.name}
                </Link>
              </li>
            ))}
          </ul>
          {project && <p className="login-hint is-top">{k.projectLead(project.name)}</p>}
        </nav>
      )}

      {groups.map((g) => (
        <section key={g.title} className="org-section" aria-labelledby={`keys-${g.title}`}>
          <h2 id={`keys-${g.title}`} className="section-label">
            {k[g.title]}
          </h2>
          <ul className="plain-list">
            {g.keys.map((name) => row(name, false))}
            {g.title === "linear" && !project && row("linear-api-key", true)}
          </ul>
        </section>
      ))}

      <section className="org-section" aria-labelledby="keys-workers">
        <h2 id="keys-workers" className="section-label">
          {k.workerSecrets}
        </h2>
        <p className="login-hint is-top">{k.workerSecretsHint(!project)}</p>
        {workerSecrets.length === 0 ? (
          <p className="faint">{k.noSecrets}</p>
        ) : (
          <ul className="plain-list">{workerSecrets.map(workerRow)}</ul>
        )}
        {fromOrganization.length > 0 && (
          <p className="login-hint is-top mono">{k.fromOrganization(fromOrganization.join(", "))}</p>
        )}
        {manager && (
          <form action={saveKey} className="invite-form">
            <input type="hidden" name="scope" value={secretScope} />
            {project && <input type="hidden" name="project" value={slug} />}
            <label className="sr-only" htmlFor="secret-name">
              {k.secretName}
            </label>
            <input
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
            <input
              id="secret-value"
              name="value"
              type="password"
              required
              autoComplete="new-password"
              spellCheck={false}
              placeholder={k.newValue}
              maxLength={32768}
            />
            <button type="submit" className="btn is-primary">
              {k.add}
            </button>
          </form>
        )}
      </section>

      {manager && (
        <section className="org-section" aria-labelledby="keys-audit">
          <h2 id="keys-audit" className="section-label">
            {k.audit}
          </h2>
          <p className="login-hint is-top">
            {k.auditHint}
            {project ? ` ${k.auditProjectHint(project.name)}` : ""}
          </p>
          {events.length === 0 ? (
            <p className="faint">{k.noEvents}</p>
          ) : (
            <ul className="plain-list">
              {events.map((e) => (
                <li key={e.id} className="member-row">
                  <span className="member-who">
                    <b>{e.actor.label}</b>
                    <span className="role-tag">{k.actions[e.action]}</span>
                    {!project && e.project && <span className="role-tag mono">{e.project}</span>}
                    <span className="mono member-mail">{e.keys.length ? e.keys.join(", ") : k.nothing}</span>
                    <span className="member-mail">{e.detail}</span>
                  </span>
                  <span className="member-mail tnum key-when">{when(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {foot}
    </AuthCard>
  );
}
