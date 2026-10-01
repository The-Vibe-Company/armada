import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { linkGithubInstallation, unlinkGithubInstallation } from "@/app/github-actions";
import { AuthCard } from "@/components/AuthCard";
import { homeOrganization, requireAccounts, requireMember, viewerGithubToken } from "@/lib/accounts-server";
import { accountsModeOf, ORGANIZATION_PATH } from "@/lib/accounts-settings";
import {
  type AppInfo,
  GITHUB_APP_VARIABLES,
  githubAppModeOf,
  type Installation,
  linkedInstallations,
  userInstallations,
} from "@/lib/github-app";
import {
  GITHUB_ERRORS,
  GITHUB_NOTICES,
  type GithubError,
  type GithubNotice,
  LANGUAGE_COOKIE,
  STRINGS,
} from "@/lib/i18n";
import { githubApp, languageOf } from "@/lib/server";

// The Armada GitHub App (THE-851): where the app is installed from, the
// installations this organization reads GitHub through, and, for owners and
// admins, the installations GitHub lets them reach, to link. No token reaches
// this page.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.github.nav} — Armada` };
}

type Params = Promise<{ error?: string | string[]; done?: string | string[] }>;

const pick = <T extends string>(list: readonly T[], v: string | string[] | undefined): T | null =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;

export default async function Github({ searchParams }: { searchParams: Params }) {
  if (accountsModeOf(process.env).kind !== "accounts") notFound();
  const viewer = await requireMember();
  const [{ client }, jar, params] = await Promise.all([requireAccounts(), cookies(), searchParams]);
  const lang = languageOf(jar.get(LANGUAGE_COOKIE)?.value);
  const t = STRINGS[lang];
  const g = t.github;
  const manager = viewer.organization.role === "owner" || viewer.organization.role === "admin";
  const error = pick<GithubError>(GITHUB_ERRORS, params.error);
  const done = pick<GithubNotice>(GITHUB_NOTICES, params.done);
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
      <a className="link" href="/">
        {t.org.back}
      </a>
    </div>
  );
  const mode = githubAppModeOf(process.env);
  const app = githubApp();
  if (mode.kind !== "on" || !app)
    return (
      <AuthCard wide brandSub={t.brandSub} kicker={g.nav} heading={viewer.organization.name} lead={g.lead}>
        <p className="login-error" role="alert">
          {mode.kind === "invalid"
            ? g.invalid(mode.reason)
            : g.off(`${GITHUB_APP_VARIABLES.id}, ${GITHUB_APP_VARIABLES.privateKey}`)}
        </p>
        {foot}
      </AuthCard>
    );

  const [info, home, linked] = await Promise.all([
    app.info().catch((err: unknown): AppInfo | null => {
      console.error(`armada dashboard: GitHub App: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }),
    homeOrganization(),
    linkedInstallations(client, viewer.organization.id),
  ]);
  // Asked of GitHub with the viewer's own sign-in, so only managers who may link pay for it.
  let reachable: Installation[] | null = null;
  if (manager) {
    const token = await viewerGithubToken();
    reachable = token ? await userInstallations(globalThis.fetch, token).catch(() => null) : null;
  }
  const isLinked = new Set(linked.map((i) => i.id));
  const toLink = reachable?.filter((i) => !isLinked.has(i.id)) ?? [];

  return (
    <AuthCard wide brandSub={t.brandSub} kicker={g.nav} heading={viewer.organization.name} lead={g.lead}>
      {error && (
        <p className="login-error" role="alert">
          {g.errors[error]}
        </p>
      )}
      {done && (
        <p className="login-notice" role="status">
          {g.notices[done]}
        </p>
      )}
      {!manager && <p className="login-hint is-top">{g.onlyAdmins}</p>}

      <section className="org-section" aria-labelledby="github-app">
        <h2 id="github-app" className="section-label">
          {info?.name ?? g.nav}
        </h2>
        {info ? (
          <>
            <a className="link" href={`${info.url}/installations/new`} target="_blank" rel="noreferrer">
              {g.install} →
            </a>
            <p className="login-hint">{g.installHint}</p>
          </>
        ) : (
          <p className="login-hint">{g.appUnreachable}</p>
        )}
        {home === viewer.organization.id && <p className="login-hint">{g.home}</p>}
      </section>

      <section className="org-section" aria-labelledby="github-linked">
        <h2 id="github-linked" className="section-label">
          {g.linked}
        </h2>
        {home !== viewer.organization.id && <p className="login-hint is-top">{g.linkedHint}</p>}
        {linked.length === 0 ? (
          <p className="faint">{g.noneLinked}</p>
        ) : (
          <ul className="plain-list">
            {linked.map((i) => (
              <li key={i.id} className="member-row">
                <span className="member-who">
                  <b>{i.account}</b>
                  <span className="mono member-mail">{i.id}</span>
                  <span className="member-mail">{g.linkedBy(i.linkedBy, when(i.linkedAt))}</span>
                </span>
                {manager && (
                  <form action={unlinkGithubInstallation} className="row-actions">
                    <input type="hidden" name="installation" value={i.id} />
                    <button type="submit" className="btn is-danger">
                      {g.unlink}
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {manager && (
        <section className="org-section" aria-labelledby="github-reachable">
          <h2 id="github-reachable" className="section-label">
            {g.reachable}
          </h2>
          {reachable === null ? (
            <p className="login-hint is-top">{g.noGithub}</p>
          ) : (
            <>
              <p className="login-hint is-top">{g.reachableHint}</p>
              {toLink.length === 0 ? (
                <p className="faint">{reachable.length === 0 ? g.noneReachable : g.allLinked}</p>
              ) : (
                <ul className="plain-list">
                  {toLink.map((i) => (
                    <li key={i.id} className="member-row">
                      <span className="member-who">
                        <b>{i.account}</b>
                        <span className="mono member-mail">{i.id}</span>
                      </span>
                      <form action={linkGithubInstallation} className="row-actions">
                        <input type="hidden" name="installation" value={i.id} />
                        <button type="submit" className="btn is-primary">
                          {g.link}
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}
      {foot}
    </AuthCard>
  );
}
