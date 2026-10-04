import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { revokeWorker } from "@/app/workers-actions";
import { OrgBar, OrgNone, OrgPage, OrgRow, OrgRows } from "@/components/org";
import { Form, Notice } from "@/components/page";
import { requireAccounts, requireMember } from "@/lib/accounts-server";
import { accountsModeOf } from "@/lib/accounts-settings";
import { LANGUAGE_COOKIE, STRINGS, WORKERS_ERRORS, type WorkersError } from "@/lib/i18n";
import { languageOf } from "@/lib/server";
import { listWorkers, type WorkerState, workerState } from "@/lib/workers";

// The workers launched with a one-time launch token (THE-841, THE-1021 on
// design/dashboard-v7): per launch, the ticket, who launched it and when, its
// token and its session, and where it stands. Owners and admins revoke one.
// No token appears here: only their hashes are stored.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.workers.nav} — Armada` };
}

/** A launch's state in the design's colors: a token waiting, a session at work, gone quiet, ended or revoked. */
const COLOR: Record<WorkerState, string> = {
  waiting: "var(--amber)",
  active: "var(--green)",
  idle: "var(--amber)",
  unused: "var(--text-3)",
  expired: "var(--text-3)",
  released: "var(--text-3)",
  merged: "var(--green)",
  revoked: "var(--red)",
};

type Params = Promise<{ error?: string | string[]; done?: string | string[] }>;

export default async function Workers({ searchParams }: { searchParams: Params }) {
  if (accountsModeOf(process.env).kind !== "accounts") notFound();
  const viewer = await requireMember();
  const [{ client }, jar, params] = await Promise.all([requireAccounts(), cookies(), searchParams]);
  const lang = languageOf(jar.get(LANGUAGE_COOKIE)?.value);
  const t = STRINGS[lang];
  const w = t.workers;
  const manager = viewer.organization.role === "owner" || viewer.organization.role === "admin";
  const error =
    typeof params.error === "string" && (WORKERS_ERRORS as readonly string[]).includes(params.error)
      ? (params.error as WorkersError)
      : null;
  const revoked = params.done === "revoked";
  const date = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const when = (iso: string) => date.format(new Date(iso));
  const now = new Date();
  const workers = await listWorkers(client, viewer.organization.id, 100);

  return (
    <OrgPage t={t} name={viewer.organization.name} page="workers">
      {error && <Notice tone="critical">{w.errors[error]}</Notice>}
      {revoked && <Notice tone="done">{w.revoked}</Notice>}
      <OrgBar hint={`${w.lead} ${manager ? w.revokeHint : w.onlyAdmins}`} />
      <OrgRows>
        {workers.length === 0 && <OrgNone>{`${w.none} ${w.noneHint}`}</OrgNone>}
        {workers.map((x) => {
          const state = workerState(x, now);
          const token = x.tokenUsedAt
            ? w.tokenUsed(when(x.tokenUsedAt))
            : state === "waiting"
              ? w.tokenValid(when(x.tokenExpiresAt))
              : w.tokenExpired(when(x.tokenExpiresAt));
          const session = x.endedAt
            ? w.endedBy(x.endedBy ?? "?", when(x.endedAt))
            : x.sessionSeenAt
              ? w.lastSeen(when(x.sessionSeenAt))
              : null;
          return (
            <OrgRow
              key={x.id}
              a={<span className="mono">{x.ticket}</span>}
              sub={`${x.project} · ${w.launchedBy(x.launchedBy.label)}, ${when(x.createdAt)}`}
              b={session ?? token}
              c={w.states[state]}
              color={COLOR[state]}
              d={
                manager &&
                (state === "waiting" || state === "active") && (
                  <Form action={revokeWorker}>
                    <input type="hidden" name="id" value={x.id} />
                    <button type="submit" className="org-link">
                      {w.revoke}
                    </button>
                  </Form>
                )
              }
            />
          );
        })}
      </OrgRows>
    </OrgPage>
  );
}
