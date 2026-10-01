import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteKey, saveKey } from "@/app/keys-actions";
import { AuthCard } from "@/components/AuthCard";
import { requireAccounts, requireMember } from "@/lib/accounts-server";
import { accountsModeOf, ORGANIZATION_PATH } from "@/lib/accounts-settings";
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
  listEvents,
  listSecrets,
  SECRET_KINDS,
  SECRETS_KEY_VARIABLE,
  type SecretInfo,
  type SecretName,
  vaultModeOf,
} from "@/lib/vault";

// The organization's keys (THE-840). Owners and admins set, replace and
// delete them; every member sets their own Linear key. A secret's value never
// reaches this page: only who set it and when (`listSecrets` returns no
// secret value). Owners and admins read the audit list.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.keys.nav} — Armada` };
}

type Params = Promise<{ error?: string | string[]; done?: string | string[] }>;

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

  const secrets = await listSecrets(client, vault.key, {
    organization: viewer.organization.id,
    user: viewer.user.id,
  });
  const events = manager ? await listEvents(client, viewer.organization.id, 50) : [];
  const find = (name: SecretName, own: boolean) => secrets.find((s) => s.name === name && s.own === own) ?? null;

  const row = (name: SecretName, own: boolean) => {
    const label: KeyLabel = own ? "own-linear-api-key" : name;
    const info: SecretInfo | null = find(name, own);
    const editable = own || manager;
    const secret = SECRET_KINDS[name].secret;
    const id = `key-${label}`;
    return (
      <li key={label} className="key-row">
        <span className="member-who">
          <b>{k.labels[label]}</b>
          <span className="member-mail">
            {info ? `${k.setBy(info.setBy, when(info.setAt))}${info.readable ? "" : ` · ${k.unreadable}`}` : k.notSet}
          </span>
        </span>
        <span className="member-mail">{k.hints[label]}</span>
        {info?.value && <code className="mono key-value">{info.value}</code>}
        {editable && (
          <span className="row-actions is-key">
            <form action={saveKey} className="invite-form">
              <input type="hidden" name="name" value={name} />
              <input type="hidden" name="scope" value={own ? "own" : "organization"} />
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
                <input type="hidden" name="name" value={name} />
                <input type="hidden" name="scope" value={own ? "own" : "organization"} />
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

      {GROUPS.map((g) => (
        <section key={g.title} className="org-section" aria-labelledby={`keys-${g.title}`}>
          <h2 id={`keys-${g.title}`} className="section-label">
            {k[g.title]}
          </h2>
          <ul className="plain-list">
            {g.keys.map((name) => row(name, false))}
            {g.title === "linear" && row("linear-api-key", true)}
          </ul>
        </section>
      ))}

      {manager && (
        <section className="org-section" aria-labelledby="keys-audit">
          <h2 id="keys-audit" className="section-label">
            {k.audit}
          </h2>
          <p className="login-hint is-top">{k.auditHint}</p>
          {events.length === 0 ? (
            <p className="faint">{k.noEvents}</p>
          ) : (
            <ul className="plain-list">
              {events.map((e) => (
                <li key={e.id} className="member-row">
                  <span className="member-who">
                    <b>{e.actor.label}</b>
                    <span className="role-tag">{k.actions[e.action]}</span>
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
