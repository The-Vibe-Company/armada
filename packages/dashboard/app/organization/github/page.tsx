import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { linkGithubInstallation, unlinkGithubInstallation } from "@/app/github-actions";
import { OrgBar, OrgHeading, OrgNone, OrgPage, OrgRow, OrgRows } from "@/components/org";
import { Form, Notice } from "@/components/page";
import { homeOrganization, requireAccounts, requireMember, viewerGithubToken } from "@/lib/accounts-server";
import { accountsModeOf, GITHUB_INSTALL_PATH, GITHUB_SETUP_PATH } from "@/lib/accounts-settings";
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

// The Armada GitHub App (THE-851, THE-1021 on design/dashboard-v7): where
// the app is installed from, the installations this organization reads
// GitHub through, and, for owners and admins, the installations GitHub lets
// them reach, to link. No token reaches this page.
//
// It is also the app's Setup URL (THE-852): GitHub's return from the install
// page is handed to GITHUB_SETUP_PATH, which links the installation and comes
// back here with the outcome. This page writes nothing.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.github.nav} — Armada` };
}

type Param = string | string[] | undefined;
/** GitHub's query on the Setup URL. */
const SETUP_PARAMS = ["installation_id", "setup_action", "state"] as const;
type Params = Promise<{ error?: Param; done?: Param } & Partial<Record<(typeof SETUP_PARAMS)[number], Param>>>;

const pick = <T extends string>(list: readonly T[], v: string | string[] | undefined): T | null =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;

export default async function Github({ searchParams }: { searchParams: Params }) {
  if (accountsModeOf(process.env).kind !== "accounts") notFound();
  const viewer = await requireMember();
  const [{ client }, jar, params] = await Promise.all([requireAccounts(), cookies(), searchParams]);
  const setup = new URLSearchParams();
  for (const name of SETUP_PARAMS) {
    const v = params[name];
    if (typeof v === "string") setup.set(name, v);
  }
  if (setup.size > 0) redirect(`${GITHUB_SETUP_PATH}?${setup}`);
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

  const mode = githubAppModeOf(process.env);
  const app = githubApp();
  const name = viewer.organization.name;
  if (mode.kind !== "on" || !app)
    return (
      <OrgPage t={t} name={name} page="github">
        <Notice tone="critical">
          {mode.kind === "invalid"
            ? g.invalid(mode.reason)
            : g.off(`${GITHUB_APP_VARIABLES.id}, ${GITHUB_APP_VARIABLES.privateKey}`)}
        </Notice>
      </OrgPage>
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
  const hint = [
    g.lead,
    info ? (manager ? g.installHint : g.installElsewhereHint) : g.appUnreachable,
    home === viewer.organization.id ? g.home : home !== null ? g.linkedHint : "",
    manager ? "" : g.onlyAdmins,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <OrgPage t={t} name={name} page="github">
      {error && <Notice tone="critical">{g.errors[error]}</Notice>}
      {done && <Notice tone="done">{g.notices[done]}</Notice>}
      <OrgBar hint={hint}>
        {info &&
          (manager ? (
            <a className="btn is-primary" href={GITHUB_INSTALL_PATH}>
              {g.install}
            </a>
          ) : (
            <a className="btn is-soft" href={`${info.url}/installations/new`} target="_blank" rel="noreferrer">
              {g.installElsewhere} ↗
            </a>
          ))}
      </OrgBar>
      <OrgRows>
        {linked.length === 0 && <OrgNone>{g.noneLinked}</OrgNone>}
        {linked.map((i) => (
          <OrgRow
            key={i.id}
            a={i.account}
            sub={g.linkedBy(i.linkedBy, when(i.linkedAt))}
            b={`#${i.id}`}
            bMono
            c={g.connected}
            color="var(--green)"
            d={
              manager && (
                <Form action={unlinkGithubInstallation}>
                  <input type="hidden" name="installation" value={i.id} />
                  <button type="submit" className="org-link">
                    {g.unlink}
                  </button>
                </Form>
              )
            }
          />
        ))}
      </OrgRows>
      {manager && (
        <>
          <OrgHeading>{g.reachable}</OrgHeading>
          <OrgRows>
            {reachable === null ? (
              <OrgNone>{g.noGithub}</OrgNone>
            ) : toLink.length === 0 ? (
              <OrgNone>{reachable.length === 0 ? g.noneReachable : g.allLinked}</OrgNone>
            ) : null}
            {toLink.map((i) => (
              <OrgRow
                key={i.id}
                a={i.account}
                sub={g.reachableHint}
                b={`#${i.id}`}
                bMono
                c={g.notLinked}
                color="var(--text-3)"
                d={
                  <Form action={linkGithubInstallation}>
                    <input type="hidden" name="installation" value={i.id} />
                    <button type="submit" className="org-link">
                      {g.link}
                    </button>
                  </Form>
                }
              />
            ))}
          </OrgRows>
        </>
      )}
    </OrgPage>
  );
}
