"use client";

// The Fleet view: what waits for the owner across every project, then one row
// per ticket in flight. It renders the overview core builds and polls the
// server for a new one every few seconds while the tab is visible.
import type { FleetOverview, FleetRow, LaneFlag, ProjectOverview, WaitingItem } from "@armada/core/read";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LANGUAGE_COOKIE, LANGUAGES, type Language, STRINGS, type Strings } from "@/lib/i18n";

const POLL_MS = 5_000;
const FRESH_MS = 20_000;

const RUNTIME_COLOR: Record<string, string> = {
  "Claude Code": "#D97757",
  Codex: "#10A37F",
  Conductor: "#BB87FC",
};

const SEVERE: LaneFlag[] = ["ci-failing", "conflict", "double-claim"];
/** Flags shown elsewhere on the row (silence has its own column) or too noisy for it. */
const HIDDEN: LaneFlag[] = ["silent", "no-phase-label"];

const since = (now: number, iso: string | null | undefined) => (iso ? now - Date.parse(iso) : 0);

function useLiveOverview(initial: FleetOverview) {
  const [overview, setOverview] = useState(initial);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const res = await fetch("/api/fleet", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setOverview((await res.json()) as FleetOverview);
      setFailed(false);
      setCheckedAt(Date.now());
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [poll]);

  return { overview, checkedAt, failed, pending, poll };
}

function useNow(initial: string) {
  // Start from the server's clock so the first render matches the HTML.
  const [now, setNow] = useState(() => Date.parse(initial));
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function Fleet({
  initial,
  initialLanguage,
  initialProject,
}: {
  initial: FleetOverview;
  initialLanguage: Language;
  initialProject: string | null;
}) {
  const { overview, checkedAt, failed, pending, poll } = useLiveOverview(initial);
  const now = useNow(initial.generatedAt);
  const [lang, setLang] = useState(initialLanguage);
  const [project, setProject] = useState(initialProject);
  const t = STRINGS[lang];

  const chooseLanguage = (next: Language) => {
    setLang(next);
    document.documentElement.lang = next;
    document.title = STRINGS[next].htmlTitle;
    // biome-ignore lint/suspicious/noDocumentCookie: a plain preference cookie, read by the server on the next load.
    document.cookie = `${LANGUAGE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  };
  const chooseProject = (next: string | null) => {
    setProject(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("project", next);
    else url.searchParams.delete("project");
    window.history.replaceState(null, "", url);
  };

  const known = overview.projects.some((p) => p.slug === project);
  const active = known ? project : null;
  const rows = useMemo(() => overview.rows.filter((r) => !active || r.project === active), [overview, active]);
  const waiting = useMemo(() => overview.waiting.filter((w) => !active || w.project === active), [overview, active]);
  const projects = overview.projects.filter((p) => !active || p.slug === active);
  const names = new Map(overview.projects.map((p) => [p.slug, p.name]));
  const silent = rows.filter((r) => r.silent).length;
  const redCi = rows.filter((r) => r.flags.includes("ci-failing")).length;

  return (
    <>
      <TopBar
        t={t}
        lang={lang}
        onLanguage={chooseLanguage}
        overview={overview}
        now={now}
        checkedAt={checkedAt}
        failed={failed}
        pending={pending}
        onRefresh={() => void poll()}
      />
      <main className="page">
        {overview.live.state === "unreachable" && (
          <div className="banner" role="status">
            {t.unreachableBanner(overview.live.error)}
          </div>
        )}
        {overview.live.state === "off" && (
          <div className="banner is-quiet" role="status">
            {t.offBanner}
          </div>
        )}

        <header className="hero">
          <div className="hero-text">
            <div className="kicker mono">{t.kicker}</div>
            <h1 className="serif">{t.heading}</h1>
            <p className="hero-line">
              {t.atWorkLine(rows.length)}
              {" · "}
              {waiting.length ? <em>{t.waitingLine(waiting.length)}</em> : t.waitingLine(0)}
            </p>
          </div>
          <dl className="stats">
            <Stat label={t.stats.waiting} value={waiting.length} tone={waiting.length ? "hot" : null} />
            <Stat label={t.stats.atWork} value={rows.length} tone={null} />
            <Stat label={t.stats.silent} value={silent} tone={silent ? "warn" : null} />
            <Stat label={t.stats.redCi} value={redCi} tone={redCi ? "bad" : null} />
          </dl>
        </header>

        {overview.projects.length > 0 && (
          <ProjectBar
            t={t}
            projects={overview.projects}
            active={active}
            onChoose={chooseProject}
            now={now}
            total={overview.rows.length}
          />
        )}

        <section className="block" aria-labelledby="waiting-h">
          <div className="block-h">
            <h2 id="waiting-h" className="serif">
              {t.waitingTitle}
            </h2>
            <span className="count tnum">{waiting.length}</span>
          </div>
          {waiting.length === 0 ? (
            <p className="calm">{t.waitingEmpty}</p>
          ) : (
            <ol className="waiting">
              {waiting.map((w, k) => (
                <WaitingRow key={`${w.project}-${w.ticket ?? k}-${w.kind}`} t={t} w={w} now={now} names={names} i={k} />
              ))}
            </ol>
          )}
        </section>

        <section className="block" aria-labelledby="crew-h">
          <div className="block-h">
            <h2 id="crew-h" className="serif">
              {t.atWorkTitle}
            </h2>
            <span className="count tnum">{rows.length}</span>
          </div>
          <ProjectProblems t={t} projects={projects} />
          {overview.projects.length === 0 ? (
            <Empty title={t.noProjects} hint={t.noProjectsHint} />
          ) : rows.length === 0 ? (
            <Empty title={t.emptyFleet} hint={t.emptyFleetHint} />
          ) : (
            <ol className="crew">
              {rows.map((r, k) => (
                <CrewRow
                  key={`${r.project}-${r.id}`}
                  t={t}
                  row={r}
                  now={now}
                  projectName={names.get(r.project) ?? r.project}
                  i={k}
                />
              ))}
            </ol>
          )}
        </section>

        <Footer t={t} projects={projects} now={now} />
      </main>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "hot" | "warn" | "bad" | null }) {
  return (
    <div className={`stat ${tone ? `is-${tone}` : ""}`}>
      <dt>{label}</dt>
      <dd className="serif tnum">{value}</dd>
    </div>
  );
}

function TopBar({
  t,
  lang,
  onLanguage,
  overview,
  now,
  checkedAt,
  failed,
  pending,
  onRefresh,
}: {
  t: Strings;
  lang: Language;
  onLanguage: (l: Language) => void;
  overview: FleetOverview;
  now: number;
  checkedAt: number | null;
  failed: boolean;
  pending: boolean;
  onRefresh: () => void;
}) {
  const state = failed ? "offline" : overview.live.state;
  const label = failed ? t.offline : t.live[overview.live.state];
  const checked = checkedAt ?? Date.parse(overview.generatedAt);
  return (
    <header className="topbar">
      <div className="topbar-in">
        <a href="/" className="brand">
          <span className="brand-mark" aria-hidden />
          Armada <small>{t.brandSub}</small>
        </a>
        <span className="spacer" />
        <div className="refresh">
          {/* Only the source state is announced; the ticking "checked" text is not. */}
          <span className={`source is-${state}`} role="status">
            <span className={`dot ${state === "ok" ? "live" : ""}`} />
            {label}
          </span>
          <span className="refresh-text tnum">{pending && !checkedAt ? t.refreshing : t.checked(now - checked)}</span>
          <button
            type="button"
            className={`icon-btn ${pending ? "spin" : ""}`}
            onClick={onRefresh}
            title={t.refresh}
            aria-label={t.refresh}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
              <path
                d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <fieldset className="lang">
          <legend className="sr-only">{t.language}</legend>
          {LANGUAGES.map((l) => (
            <button key={l} type="button" aria-pressed={l === lang} onClick={() => onLanguage(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </fieldset>
      </div>
    </header>
  );
}

function ProjectBar({
  t,
  projects,
  active,
  onChoose,
  now,
  total,
}: {
  t: Strings;
  projects: ProjectOverview[];
  active: string | null;
  onChoose: (slug: string | null) => void;
  now: number;
  total: number;
}) {
  return (
    <nav className="projects" aria-label={t.filterLabel}>
      <button type="button" className="proj" aria-pressed={!active} onClick={() => onChoose(null)}>
        <span className="proj-name">{t.allProjects}</span>
        <span className="proj-n tnum">{total}</span>
      </button>
      {projects.map((p) => {
        const ago = p.coordinator.seenAt ? t.duration(since(now, p.coordinator.seenAt)) : null;
        return (
          <button
            key={p.slug}
            type="button"
            className={`proj ${p.error ? "has-error" : ""}`}
            aria-pressed={active === p.slug}
            onClick={() => onChoose(active === p.slug ? null : p.slug)}
            title={t.coordinatorHint(p.coordinator.state, ago)}
          >
            <span className="proj-name">{p.name}</span>
            <span className="proj-n tnum">{p.inFlight}</span>
            {p.waiting > 0 && <span className="proj-wait tnum">{p.waiting}</span>}
            <span className={`coord is-${p.coordinator.state}`}>
              <i aria-hidden />
              {t.coordinator[p.coordinator.state]}
              {ago && <span className="faint"> · {ago}</span>}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function WaitingRow({
  t,
  w,
  now,
  names,
  i,
}: {
  t: Strings;
  w: WaitingItem;
  now: number;
  names: Map<string, string>;
  i: number;
}) {
  return (
    <li className={`wait-row k-${w.kind}`} style={{ ["--i" as string]: i }}>
      <span className="wait-kind">{t.kinds[w.kind]}</span>
      <div className="wait-main">
        <div className="wait-title">
          {w.url ? (
            <a href={w.url} target="_blank" rel="noreferrer">
              {w.title ?? w.ticket}
            </a>
          ) : (
            (w.title ?? w.ticket ?? names.get(w.project))
          )}
        </div>
        <div className="meta">
          <span className="tag">{names.get(w.project) ?? w.project}</span>
          {w.ticket && <span className="mono">{w.ticket}</span>}
          {w.author && <span>{w.author}</span>}
        </div>
        {w.detail && <p className={`wait-detail ${w.kind === "question" ? "is-quote" : ""}`}>{w.detail}</p>}
      </div>
      <span className="wait-age tnum" title={w.since}>
        {t.duration(since(now, w.since))}
      </span>
      {w.url && (
        <a className="wait-open" href={w.url} target="_blank" rel="noreferrer">
          {t.open} ↗
        </a>
      )}
    </li>
  );
}

function phaseTitle(t: Strings, r: FleetRow) {
  if (r.phaseSource === "live") return t.sourceLive;
  if (r.phaseSource === "inferred") return t.sourceInferred;
  if (r.phaseSource === "status-line") return t.sourceStatusLine;
  return undefined;
}

function phaseLabel(t: Strings, r: FleetRow) {
  if (r.phase === "shipping" && r.pr?.ci === "failure") return t.ciRed;
  if (r.phase === "shipping" && r.pr?.ci === "pending") return t.ciRunning;
  return t.phases[r.phase];
}

function CrewRow({
  t,
  row: r,
  now,
  projectName,
  i,
}: {
  t: Strings;
  row: FleetRow;
  now: number;
  projectName: string;
  i: number;
}) {
  const fresh = r.lastReport !== null && since(now, r.lastReport) < FRESH_MS;
  const flags = r.flags.filter((f) => !HIDDEN.includes(f));
  const rt = r.runtime ? (RUNTIME_COLOR[r.runtime] ?? "var(--muted)") : "var(--faint)";
  const step = t.steps[r.pipeline.step] ?? "";
  return (
    <li
      className={`crew-row ${r.waiting && r.waiting !== "silent" ? "is-waiting" : ""} ${fresh ? "is-fresh" : ""}`}
      style={{ ["--i" as string]: i, ["--rt" as string]: rt }}
    >
      <span className="crew-rt" aria-hidden />
      <div className="crew-main">
        <a className="crew-title" href={r.url} target="_blank" rel="noreferrer">
          {r.title}
        </a>
        <div className="meta">
          <span className="tag">{projectName}</span>
          <span className="mono">{r.id}</span>
          <span className="rt">
            <i className="rt-mark" aria-hidden />
            {r.runtime ?? t.runtimeUnknown}
          </span>
          {r.handle && (
            <span className="mono faint handle" title={r.handle}>
              {r.handle}
            </span>
          )}
          {r.pr ? (
            <a className="pr" href={r.pr.url} target="_blank" rel="noreferrer">
              <span className="mono">#{r.pr.number}</span>
              {r.pr.draft && <span className="faint">{t.draft}</span>}
              <span className={`ci-dot ${r.pr.ci ?? "none"}`} title={t.ci[r.pr.ci ?? "none"]} />
            </a>
          ) : null}
          {flags.map((f) => (
            <span key={f} className={`flag ${SEVERE.includes(f) ? "is-severe" : ""}`}>
              {t.flags[f]}
            </span>
          ))}
        </div>
        {r.question ? (
          <p className="crew-question">
            <span className="q-mark" aria-hidden>
              ?
            </span>
            <span className="sr-only">{t.question}: </span>
            {r.question.body}
          </p>
        ) : (
          r.statusLine && (
            <p className="crew-status" title={r.statusLine.summary}>
              {r.statusLine.summary}
            </p>
          )
        )}
      </div>
      <div className="crew-stage" title={`${step} · ${t.steps.join(" → ")}`}>
        <ol className="steps" aria-label={`${step} (${r.pipeline.step + 1}/${t.steps.length})`}>
          {t.steps.map((s, k) => (
            <li
              key={s}
              className={k < r.pipeline.step ? "on" : k === r.pipeline.step ? `now ${r.pipeline.state}` : ""}
            />
          ))}
        </ol>
        <span className="crew-phase" title={phaseTitle(t, r)}>
          {r.phaseSource === "live" && <span className="live-dot" aria-hidden />}
          {phaseLabel(t, r)}
          {r.phaseSource === "inferred" && " ≈"}
          <span className="faint"> · </span>
          <span className="tnum">{t.duration(since(now, r.since))}</span>
        </span>
      </div>
      <div className={`crew-seen ${r.silent ? "is-silent" : ""}`}>
        <span className="tnum">{r.lastReport ? t.ago(since(now, r.lastReport)) : t.neverReported}</span>
        <span className="faint">{r.silent ? t.flags.silent : t.lastReport}</span>
      </div>
    </li>
  );
}

function ProjectProblems({ t, projects }: { t: Strings; projects: ProjectOverview[] }) {
  const failing = projects.filter((p) => p.error);
  if (!failing.length) return null;
  return (
    <ul className="problems">
      {failing.map((p) => (
        <li key={p.slug}>
          <b>{t.projectError(p.name)}</b>
          <span>{p.error}</span>
        </li>
      ))}
    </ul>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="empty">
      <span className="serif">{title}</span>
      <span>{hint}</span>
    </div>
  );
}

function Footer({ t, projects, now }: { t: Strings; projects: ProjectOverview[]; now: number }) {
  const notes = projects.flatMap((p) => p.warnings.map((w) => ({ project: p.name, note: w })));
  return (
    <footer className="foot">
      <div className="foot-sources">
        {projects.map((p) => (
          <span key={p.slug}>
            <b>{p.name}</b> {p.sources ? t.linearRead(t.duration(since(now, p.sources.linear.fetchedAt))) : "—"}
            {p.sources?.github.error ? ` · ${t.githubMissing}` : ""}
          </span>
        ))}
        <span>{t.footerRefresh}</span>
      </div>
      {notes.length > 0 && (
        <details className="notes">
          <summary>{t.notes(notes.length)}</summary>
          <ul>
            {notes.map((n) => (
              <li key={`${n.project}-${n.note}`}>
                <b>{n.project}</b> {n.note}
              </li>
            ))}
          </ul>
        </details>
      )}
    </footer>
  );
}
