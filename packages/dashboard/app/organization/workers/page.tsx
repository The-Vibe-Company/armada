import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { revokeWorker } from "@/app/workers-actions";
import { AuthCard } from "@/components/AuthCard";
import { requireAccounts, requireMember } from "@/lib/accounts-server";
import { accountsModeOf, ORGANIZATION_PATH } from "@/lib/accounts-settings";
import { LANGUAGE_COOKIE, STRINGS, WORKERS_ERRORS, type WorkersError } from "@/lib/i18n";
import { languageOf } from "@/lib/server";
import { listWorkers, workerState } from "@/lib/workers";

// The workers launched with a one-time launch token (THE-841): per launch, the
// ticket, who launched it and when, when its token was used, and where its
// session stands. Owners and admins revoke one. No token appears here: only
// their hashes are stored.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.workers.nav} — Armada` };
}

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
    <AuthCard wide brandSub={t.brandSub} kicker={w.nav} heading={viewer.organization.name} lead={w.lead}>
      {error && (
        <p className="login-error" role="alert">
          {w.errors[error]}
        </p>
      )}
      {revoked && (
        <p className="login-notice" role="status">
          {w.revoked}
        </p>
      )}
      <p className="login-hint is-top">{manager ? w.revokeHint : w.onlyAdmins}</p>
      {workers.length === 0 ? (
        <p className="faint">{w.none}</p>
      ) : (
        <ul className="plain-list">
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
              <li key={x.id} className="member-row">
                <span className="member-who">
                  <b className="mono">{x.ticket}</b>
                  <span className="role-tag">{w.states[state]}</span>
                  <span className="member-mail">{x.project}</span>
                  <span className="member-mail">{w.launchedBy(x.launchedBy.label, when(x.createdAt))}</span>
                  <span className="member-mail">{token}</span>
                  {session && <span className="member-mail">{session}</span>}
                </span>
                {manager && (state === "waiting" || state === "active") && (
                  <form action={revokeWorker} className="row-actions">
                    <input type="hidden" name="id" value={x.id} />
                    <button type="submit" className="btn is-danger">
                      {w.revoke}
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="org-foot">
        <a className="link" href={ORGANIZATION_PATH}>
          ← {t.org.nav}
        </a>
        <Link className="link" href="/">
          {t.org.back}
        </Link>
      </div>
    </AuthCard>
  );
}
