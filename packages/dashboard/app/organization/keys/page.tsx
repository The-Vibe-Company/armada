import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { deleteKey, saveKey } from "@/app/keys-actions";
import { OrganizationTabs } from "@/components/OrganizationTabs";
import {
  Button,
  Form,
  Input,
  Notice,
  Page,
  Row,
  RowSide,
  RowText,
  RowTime,
  Section,
  SectionBody,
  Toolbar,
} from "@/components/page";
import { EmptyState, PhasePill, Tabs, Tag } from "@/components/ui";
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

  const tabs = <OrganizationTabs t={t} page="keys" />;
  if (vault.kind !== "on")
    return (
      <Page toolbar={<Toolbar>{tabs}</Toolbar>}>
        <Section label={k.nav} side={viewer.organization.name}>
          <Notice tone="critical">
            {vault.kind === "off" ? k.vaultOff(SECRETS_KEY_VARIABLE) : k.vaultInvalid(SECRETS_KEY_VARIABLE)}
          </Notice>
        </Section>
      </Page>
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
      <Row key={label} className="sc-key">
        <RowText title={k.labels[label]} line={status(info)} lineColor={info ? undefined : "var(--text-4)"} />
        {editable && (
          <RowSide>
            <Form action={saveKey}>
              {slotFields(name, scope)}
              <label className="sr-only" htmlFor={id}>
                {`${k.labels[label]}: ${k.newValue}`}
              </label>
              <Input
                id={id}
                name="value"
                type={secret ? "password" : "text"}
                required
                autoComplete={secret ? "new-password" : "off"}
                spellCheck={false}
                placeholder={k.newValue}
                maxLength={4096}
              />
              <Button tone="primary">{info ? k.replace : k.save}</Button>
            </Form>
            {info && (
              <Form action={deleteKey}>
                {slotFields(name, scope)}
                <Button tone="danger">{k.remove}</Button>
              </Form>
            )}
          </RowSide>
        )}
        <span className="sc-key-wide sc-key-hint">{k.hints[label]}</span>
        {info?.value && <code className="mono sc-key-wide sc-key-value">{info.value}</code>}
      </Row>
    );
  };

  const secretScope = project ? "project" : "organization";
  const workerRow = (info: SecretInfo) => {
    const id = `secret-${info.name}`;
    return (
      <Row key={info.name} className="sc-key">
        <RowText title={<span className="mono">{info.name}</span>} line={status(info)} />
        {manager && (
          <RowSide>
            <Form action={saveKey}>
              {slotFields(info.name, secretScope)}
              <label className="sr-only" htmlFor={id}>
                {`${info.name}: ${k.newValue}`}
              </label>
              <Input
                id={id}
                name="value"
                type="password"
                required
                autoComplete="new-password"
                spellCheck={false}
                placeholder={k.newValue}
                maxLength={32768}
              />
              <Button tone="primary">{k.replace}</Button>
            </Form>
            <Form action={deleteKey}>
              {slotFields(info.name, secretScope)}
              <Button tone="danger">{k.remove}</Button>
            </Form>
          </RowSide>
        )}
      </Row>
    );
  };

  const groups = project ? GROUPS.filter((g) => g.title === "linear") : GROUPS;
  const scopeHref = (p: string) => (p ? `${KEYS_PATH}?${new URLSearchParams({ project: p })}` : KEYS_PATH);

  return (
    <Page
      toolbar={
        <Toolbar
          end={
            projects.length > 0 && (
              <Tabs
                label={k.scope}
                value={slug}
                items={[{ slug: "", name: k.organizationScope }, ...projects].map((p) => ({
                  key: p.slug,
                  label: p.name,
                  href: scopeHref(p.slug),
                }))}
              />
            )
          }
        >
          {tabs}
        </Toolbar>
      }
    >
      {error && <Notice tone="critical">{k.errors[error]}</Notice>}
      {done && <Notice tone="done">{k.notices[done]}</Notice>}

      {groups.map((g, i) => (
        <Section
          key={g.title}
          label={k[g.title]}
          side={i === 0 ? (project?.name ?? viewer.organization.name) : undefined}
        >
          {i === 0 && (
            <SectionBody>
              <p>{project ? k.projectLead(project.name) : k.lead}</p>
              {!manager && <p className="faint">{k.onlyAdmins}</p>}
            </SectionBody>
          )}
          {g.keys.map((name) => row(name, false))}
          {g.title === "linear" && !project && row("linear-api-key", true)}
        </Section>
      ))}

      <Section label={k.workerSecrets} count={workerSecrets.length}>
        <SectionBody>
          <p>{k.workerSecretsHint(!project)}</p>
          {fromOrganization.length > 0 && (
            <p className="faint mono">{k.fromOrganization(fromOrganization.join(", "))}</p>
          )}
        </SectionBody>
        {workerSecrets.length === 0 && <EmptyState compact title={k.noSecrets} />}
        {workerSecrets.map(workerRow)}
        {manager && (
          <SectionBody>
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
          </SectionBody>
        )}
      </Section>

      {manager && (
        <Section label={k.audit} count={events.length}>
          <SectionBody>
            <p>
              {k.auditHint}
              {project ? ` ${k.auditProjectHint(project.name)}` : ""}
            </p>
          </SectionBody>
          {events.length === 0 && <EmptyState compact title={k.noEvents} />}
          {events.map((e) => (
            <Row key={e.id}>
              <RowText
                title={e.actor.label}
                line={
                  <>
                    <span className="mono">{e.keys.length ? e.keys.join(", ") : k.nothing}</span>
                    {e.detail && <> · {e.detail}</>}
                  </>
                }
              />
              <RowSide>
                {!project && e.project && <Tag>{e.project}</Tag>}
                <PhasePill tone={e.action === "refuse" ? "error" : "neutral"}>{k.actions[e.action]}</PhasePill>
              </RowSide>
              <RowTime>{when(e.at)}</RowTime>
            </Row>
          ))}
        </Section>
      )}
    </Page>
  );
}
