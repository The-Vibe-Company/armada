"use client";

// /validations and /approve/<id> (THE-885, THE-1021 on design/dashboard-v7):
// what waits for the owner (merges to approve, work to validate, questions
// the coordinator escalated) in a list on the left, with what they decided
// this week under it, and the selected one whole on the right. /approve/<id>
// is the link the coordinator sends: the same page with that one selected.
// On a phone the list is /validations and a row opens /approve/<id>, the
// validation alone with the way back. Both render from the overview the
// shell polls, which holds the viewer's organization's projects only. The
// keys decide the selected one (THE-1113, lib/validation-keys.ts): A, C and
// 1–6, never while typing; once recorded, the next waiting one opens.
import type { OwnerValidation } from "@armada/core/read";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { paths } from "@/lib/fleet-view";
import { ownsKeys } from "@/lib/keyboard";
import { splitValidations } from "@/lib/overview-view";
import { decisionMedian, nextOpen, pressOf } from "@/lib/validation-keys";
import type { ActionContext } from "../Actions";
import { Alert } from "../page";
import { useFleet, useNow, useShell } from "../shell/context";
import { RelativeTime } from "../ui";
import { type DecideKeys, type Sent, VALIDATION_COLOR, ValidationDetail, validationTitle } from "./ValidationCard";

const MINUTE = 60_000;

/**
 * The decisions sent from this tab, kept across the page's moves (each
 * /approve/<id> mounts a screen of its own): out of the waiting list before
 * the overview shows them decided, so a key never decides one twice, and the
 * last one said for a while.
 */
const sentHere: { sent: Map<number, Sent>; last: { ticket: string; at: number } | null } = {
  sent: new Map(),
  last: null,
};
const SAID_MS = 20_000;

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

/** The list beside the one chosen: the address's (/approve/<id>), else the oldest waiting. */
function Validations({ chosen }: { chosen: number | null }) {
  const { overview } = useFleet();
  const ctx = useActionContext();
  const router = useRouter();
  const { t, now } = ctx;
  const s = t.validations;
  const names = useMemo(() => new Map(overview.projects.map((p) => [p.slug, p.name])), [overview]);
  const split = useMemo(() => splitValidations(overview.validations ?? []), [overview]);
  const [, sentOne] = useState(0);
  const pending = split.pending.filter((v) => !sentHere.sent.has(v.id));
  // Said after the first paint, so a screen reader hears it on the screen the next one opened on.
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    setSaid(sentHere.last && now - sentHere.last.at < SAID_MS ? sentHere.last.ticket : null);
  }, [now]);
  const { decided } = split;
  const selected =
    chosen === null ? (pending[0] ?? null) : ([...split.pending, ...decided].find((v) => v.id === chosen) ?? null);
  const oldest = pending[0]?.createdAt ?? null;
  const median = useMemo(() => decisionMedian(overview.validations ?? []), [overview]);
  const estimate =
    median !== null && pending.length ? s.estimate(t.duration(Math.max(MINUTE, pending.length * median))) : null;

  // The keys reach the selected validation's buttons; a field or a dialog keeps its own.
  const decide = useRef<DecideKeys>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || ownsKeys(e.target)) return;
      if (decide.current?.press(pressOf(e, "page"))) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Once recorded, the next waiting one opens; none left, the list says so. Not
  // when the owner moved on while it was sent: the screen left, or shows another.
  const latest = useRef({ pending: split.pending, shown: selected?.id ?? null, mounted: false });
  latest.current.pending = split.pending;
  latest.current.shown = selected?.id ?? null;
  useEffect(() => {
    const here = latest.current;
    here.mounted = true;
    return () => {
      here.mounted = false;
    };
  }, []);
  const advance = (id: number, ticket: string, sent: Sent) => {
    sentHere.sent.set(id, sent);
    sentHere.last = { ticket, at: Date.now() };
    const { pending: waiting, shown, mounted } = latest.current;
    if (!mounted) return;
    sentOne((n) => n + 1);
    if (shown !== id) return;
    const next = nextOpen(waiting, id, sentHere.sent);
    router.push(next === null ? paths.validations : paths.validation(next));
  };
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
            {estimate && `${estimate} `}
            {oldest ? s.oldest(t.duration(Math.max(0, now - Date.parse(oldest)))) : s.caughtUp}
          </p>
          <p className="vd-sent" role="status">
            {said && s.sentOne(said)}
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
            keys={decide}
            onDone={(sent) => advance(selected.id, selected.ticket, sent)}
            sentBefore={selected.decision ? null : (sentHere.sent.get(selected.id) ?? null)}
          />
        ) : (
          <p className="pg-none">{chosen === null ? s.noPending : s.notFound}</p>
        )}
      </div>
    </div>
  );
}
