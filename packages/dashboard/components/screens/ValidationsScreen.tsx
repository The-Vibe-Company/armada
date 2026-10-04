"use client";

// /validations and /approve/<id> (THE-885, THE-1021 on design/dashboard-v7):
// what waits for the owner (merges to approve, work to validate, questions
// the coordinator escalated) in a list on the left, with what they decided
// this week under it, and the selected one whole on the right. /approve/<id>
// is the link the coordinator sends: the same page with that one selected.
// On a phone the list is /validations and a row opens /approve/<id>, the
// validation alone with the way back. Both render from the overview the
// shell polls, which holds the viewer's organization's projects only.
import type { OwnerValidation } from "@armada/core/read";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { paths } from "@/lib/fleet-view";
import { splitValidations } from "@/lib/overview-view";
import type { ActionContext } from "../Actions";
import { Alert } from "../page";
import { useFleet, useNow, useShell } from "../shell/context";
import { RelativeTime } from "../ui";
import { VALIDATION_COLOR, ValidationDetail, validationTitle } from "./ValidationCard";

function useActionContext(): ActionContext {
  const { overview, failed, refresh, version } = useFleet();
  const { t, author, setAuthor, account } = useShell();
  const now = useNow();
  return {
    t,
    signer: { name: author, set: setAuthor, fixed: account !== null },
    live: overview.live.state === "ok" && !failed,
    now,
    version,
    refresh,
  };
}

export function ValidationsScreen() {
  return <Validations chosen={null} />;
}

export function ApproveScreen() {
  const id = Number(useParams<{ id: string }>().id);
  return <Validations chosen={Number.isSafeInteger(id) ? id : -1} />;
}

/** The list beside the one chosen: the address's (/approve/<id>), else the oldest waiting, else the last decided. */
function Validations({ chosen }: { chosen: number | null }) {
  const { overview } = useFleet();
  const ctx = useActionContext();
  const { t, now } = ctx;
  const s = t.validations;
  const names = useMemo(() => new Map(overview.projects.map((p) => [p.slug, p.name])), [overview]);
  const { pending, decided } = useMemo(() => splitValidations(overview.validations ?? []), [overview]);
  const selected =
    chosen === null
      ? (pending[0] ?? decided[0] ?? null)
      : ([...pending, ...decided].find((v) => v.id === chosen) ?? null);
  const oldest = pending[0]?.createdAt ?? null;
  const row = (v: OwnerValidation) => {
    const on = v.id === selected?.id;
    const color = VALIDATION_COLOR[v.kind];
    const outcome = v.decision ? (v.decision.answer ?? s.outcome[v.decision.outcome]) : null;
    return (
      <li key={v.id}>
        <Link
          href={paths.validation(v.id)}
          prefetch={false}
          scroll={false}
          data-row
          className={v.decision ? "vd-row is-decided" : "vd-row"}
          aria-current={on ? "true" : undefined}
        >
          <span className="vd-row-top">
            {outcome ? (
              <span style={{ color: v.decision?.outcome === "approved" ? "var(--green)" : "var(--text-2)" }}>
                {s.by(outcome, v.decision?.by ?? null)}
              </span>
            ) : (
              <>
                <span className="ov-dot is-small" style={{ background: color }} aria-hidden />
                <span style={{ color }}>{s.kinds[v.kind]}</span>
              </>
            )}
            <span className="spacer" />
            <span className="vd-row-ago">
              <RelativeTime at={v.decision?.at ?? v.createdAt} />
            </span>
          </span>
          <span className="vd-row-what">{validationTitle(v)}</span>
          {!v.decision && (
            <span className="vd-row-meta">
              <span className="mono">{v.ticket}</span>
              <span aria-hidden>·</span>
              <span>{names.get(v.project) ?? v.project}</span>
            </span>
          )}
        </Link>
      </li>
    );
  };
  return (
    <div className={chosen === null ? "vd" : "vd is-chosen"}>
      <nav className="vd-list" aria-label={t.shell.nav.validations}>
        <div className="vd-list-head">
          <p className="vd-headline">{s.headline(pending.length)}</p>
          <p className="vd-subline">
            {oldest ? s.oldest(t.duration(Math.max(0, now - Date.parse(oldest)))) : s.caughtUp}
          </p>
        </div>
        <h2 className="vd-list-h">{s.pendingTitle}</h2>
        {pending.length ? (
          <ul className="vd-rows">{pending.map(row)}</ul>
        ) : (
          <p className="vd-list-none">{s.noPending}</p>
        )}
        {decided.length > 0 && (
          <>
            <h2 className="vd-list-h is-later">{s.decidedTitle}</h2>
            <ul className="vd-rows">{decided.map(row)}</ul>
          </>
        )}
      </nav>
      <div className="vd-main">
        {overview.live.state === "unreachable" && (
          <Alert tone="warn" title={t.live.unreachable}>
            {t.unreachableBanner(overview.live.error)}
          </Alert>
        )}
        <Link href={paths.validations} prefetch={false} className="vd-back">
          ← {s.back}
        </Link>
        {selected ? (
          <ValidationDetail
            key={selected.id}
            ctx={ctx}
            v={selected}
            projectName={names.get(selected.project) ?? selected.project}
          />
        ) : (
          <p className="pg-none">{chosen === null ? s.choose : s.notFound}</p>
        )}
      </div>
    </div>
  );
}
