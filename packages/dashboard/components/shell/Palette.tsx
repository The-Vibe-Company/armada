"use client";

// ⌘K (THE-895): find any ticket, pull request, agent, project, validation,
// attachment or page, and run what the fleet's buttons run. The items are
// the polled overview's plus the search index, read once from
// /api/fleet/search when the palette first opens (tagged: 304 after that), so
// typing never waits for the network. Results come grouped, the group of the
// best match first; a ticket id typed whole is the first result. ↑/↓ choose,
// Enter opens or runs, Esc steps back then closes. A launch and an answer
// open a step inside the palette with the same form as their page's button.
// The field is a combobox over a listbox of groups (THE-891's focus rules:
// the focus stays in the dialog, and goes back where it was when it closes).
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { decisionCards, sentRequest } from "@/lib/overview-view";
import {
  EMPTY_INDEX,
  flatten,
  type PaletteAction,
  pushRecent,
  RECENT_STORAGE,
  type SearchIndex,
  type SearchItem,
  search,
  searchItems,
} from "@/lib/search";
import type { ActionContext } from "../Actions";
import { DecisionActions } from "../screens/DecisionCard";
import { LaunchControl, useLaunch } from "../screens/Launch";
import { Kbd, ProjectChip, StatusDot } from "../ui";
import { useFleet, useNow, useShell } from "./context";
import { SearchIcon } from "./Logo";
import { stateLabel } from "./labels";
import { useViews } from "./views";

// ------------------------------------------------------------ the index

/**
 * The index this tab holds, whose organization it is, and its tag: the next
 * open asks only whether it changed. Another organization's is never shown.
 */
let held: { scope: string; tag: string | null; index: SearchIndex } | null = null;

function useSearchIndex(scope: string): { index: SearchIndex | null; loading: boolean } {
  const mine = held?.scope === scope ? held : null;
  const [index, setIndex] = useState<SearchIndex | null>(mine?.index ?? null);
  const [loading, setLoading] = useState(mine === null);
  useEffect(() => {
    let live = true;
    const known = held?.scope === scope ? held : null;
    fetch("/api/fleet/search", { cache: "no-store", headers: known?.tag ? { "If-None-Match": known.tag } : {} })
      .then(async (res) => {
        if (res.status === 304 || !res.ok) return;
        held = { scope, tag: res.headers.get("etag"), index: (await res.json()) as SearchIndex };
        if (live) setIndex(held.index);
      })
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [scope]);
  return { index, loading };
}

function readRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_STORAGE) ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------ the palette

type Step = Extract<PaletteAction, { kind: "launch" | "answer" }>;

export function Palette({ onClose }: { onClose: () => void }) {
  const { t, lang, setLanguage, account } = useShell();
  const { overview, failed } = useFleet();
  const router = useRouter();
  const { index, loading } = useSearchIndex(account?.organization.id ?? "");
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const [step, setStep] = useState<Step | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [count, setCount] = useState<string>("");
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const p = t.shell.palette;
  const live = overview.live.state === "ok" && !failed;
  const { views } = useViews();

  useEffect(() => setRecent(readRecent()), []);

  const items = useMemo(
    () => searchItems(overview, index ?? EMPTY_INDEX, { t, lang, organization: account !== null, live, views }),
    [overview, index, t, lang, account, live, views],
  );
  const groups = useMemo(() => search(items, query, { recent }), [items, query, recent]);
  const flat = useMemo(() => flatten(groups), [groups]);
  const active = Math.min(at, Math.max(0, flat.length - 1));
  const phases = useMemo(() => new Map(overview.rows.map((r) => [`agent:${r.project}:${r.id}`, r.phase])), [overview]);

  // Where the focus was when ⌘K opened, read before any effect moves it: it goes back there on close.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(
    () => () => {
      if (opener?.isConnected) opener.focus();
    },
    [opener],
  );

  // The chosen option stays in sight.
  useEffect(() => {
    document.getElementById(`sh-pal-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // How many results, said once typing pauses: not on every key.
  useEffect(() => {
    if (!query.trim()) return setCount("");
    const timer = setTimeout(() => setCount(p.count(flat.length)), 600);
    return () => clearTimeout(timer);
  }, [query, flat.length, p]);

  const remember = (key: string) => {
    const next = pushRecent(readRecent(), key);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_STORAGE, JSON.stringify(next));
    } catch {
      // Private mode: the recent picks last this page only.
    }
  };

  const run = (item: SearchItem | undefined) => {
    if (!item) return;
    remember(item.key);
    const a = item.action;
    if (a?.kind === "launch" || a?.kind === "answer") return setStep(a);
    if (a?.kind === "copy") {
      const done = (text: string) => {
        setNote(text);
        setTimeout(onClose, 900);
      };
      const copying = navigator.clipboard?.writeText(a.text);
      if (!copying) return done(p.copyFailed);
      void copying.then(
        () => done(p.copied(a.text)),
        () => done(p.copyFailed),
      );
      return;
    }
    if (a?.kind === "language") {
      onClose();
      return setLanguage(a.to);
    }
    if (!item.href) return;
    onClose();
    if (item.external) window.open(item.href, "_blank", "noopener,noreferrer");
    else router.push(item.href);
  };

  const back = () => setStep(null);
  // Back from a step, the field has the focus again before the next key.
  useLayoutEffect(() => {
    if (!step) input.current?.focus();
  }, [step]);

  /** Tab stays in the dialog: on its field in the list, through its controls in a step. */
  const trap = (e: React.KeyboardEvent) => {
    if (!step) {
      e.preventDefault();
      input.current?.focus();
      return;
    }
    const stops = Array.from(
      dialog.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not([type='hidden']), textarea, select, a[href], [tabindex='0']",
      ) ?? [],
    );
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop closes on click; Esc closes it from the keyboard.
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above.
    <div className="sh-palette-backdrop" onClick={onClose}>
      <div
        ref={dialog}
        className="sh-palette"
        role="dialog"
        aria-modal="true"
        aria-label={p.label}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (step) back();
            else onClose();
          } else if (e.key === "Tab") trap(e);
          else if (step) return;
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            setAt(flat.length ? (active + 1) % flat.length : 0);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setAt(flat.length ? (active - 1 + flat.length) % flat.length : 0);
          } else if (e.key === "Enter") {
            e.preventDefault();
            run(flat[active]);
          }
        }}
      >
        {step ? (
          <StepPanel step={step} onBack={back} />
        ) : (
          <>
            <div className="sh-palette-input">
              <SearchIcon size={15} />
              <input
                ref={input}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setAt(0);
                }}
                placeholder={p.placeholder}
                aria-label={p.label}
                role="combobox"
                aria-expanded="true"
                aria-autocomplete="list"
                aria-controls="sh-palette-list"
                aria-activedescendant={flat[active] ? `sh-pal-${active}` : undefined}
                autoComplete="off"
                spellCheck={false}
              />
              <Kbd>esc</Kbd>
            </div>
            <div className="sh-palette-list" id="sh-palette-list" role="listbox" aria-label={p.label}>
              {groups.map((g) => {
                const first = flat.indexOf(g.items[0] as SearchItem);
                return (
                  // biome-ignore lint/a11y/useSemanticElements: a listbox's groups are ARIA groups; a fieldset is a form's.
                  <div key={g.key} role="group" aria-label={p.groups[g.key]} className="sh-palette-group">
                    <div className="sh-palette-group-h" aria-hidden>
                      {p.groups[g.key]}
                    </div>
                    {g.items.map((item, k) => (
                      <Option
                        key={item.key}
                        item={item}
                        n={first + k}
                        selected={first + k === active}
                        query={query}
                        phase={phases.get(item.key) ?? null}
                        onHover={() => first + k !== active && setAt(first + k)}
                        onPick={() => run(item)}
                      />
                    ))}
                  </div>
                );
              })}
              {flat.length === 0 && <div className="sh-palette-empty">{p.empty}</div>}
            </div>
          </>
        )}
        <div className="sh-palette-foot">
          {note ? (
            <span className="sh-palette-note">{note}</span>
          ) : (
            <span className="sh-palette-hints" aria-hidden>
              {step ? (
                <span className="sh-palette-hint">
                  <Kbd>esc</Kbd> {p.hints.back}
                </span>
              ) : (
                <>
                  <span className="sh-palette-hint">
                    <Kbd>↑↓</Kbd> {p.hints.move}
                  </span>
                  <span className="sh-palette-hint">
                    <Kbd>↵</Kbd> {p.hints.open}
                  </span>
                  <span className="sh-palette-hint">
                    <Kbd>esc</Kbd> {p.hints.close}
                  </span>
                </>
              )}
            </span>
          )}
          {loading && !step && <span className="sh-palette-loading">{p.loading}</span>}
        </div>
        <div className="sr-only" role="status" aria-live="polite">
          {note ?? count}
        </div>
      </div>
    </div>
  );
}

/** The label with the query's first match marked. */
function Marked({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="sh-palette-hit">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

function Option({
  item,
  n,
  selected,
  query,
  phase,
  onHover,
  onPick,
}: {
  item: SearchItem;
  n: number;
  selected: boolean;
  query: string;
  phase: Parameters<typeof stateLabel>[2] | null;
  onHover: () => void;
  onPick: () => void;
}) {
  const { t } = useShell();
  const p = t.shell.palette;
  const detail =
    item.kind === "agent" && item.state && phase ? `${item.detail} · ${stateLabel(t, item.state, phase)}` : item.detail;
  return (
    <div
      id={`sh-pal-${n}`}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      className="sh-palette-item"
      onMouseMove={onHover}
      onClick={onPick}
      onKeyDown={undefined}
    >
      {item.kind === "agent" && item.state ? (
        <StatusDot status={item.state.status} />
      ) : item.kind === "project" && item.project ? (
        <ProjectChip slug={item.project} bare />
      ) : (
        <span className={`sh-palette-mark is-${item.kind}${item.closed ? " is-closed" : ""}`} aria-hidden />
      )}
      <span className="sh-palette-label">
        <Marked text={item.label} query={query} />
      </span>
      <span className="sh-palette-detail">{detail}</span>
      {item.external && <span className="sr-only">, {p.newTab}</span>}
      <span className="sh-palette-key" aria-hidden>
        {item.external ? "↗" : item.action ? p.hints.run : "↵"}
      </span>
    </div>
  );
}

// ------------------------------------------------------------ steps

/**
 * A launch or an answer inside the palette: the same form as its page's
 * button, so the same request. A form that gives way to what it sent leaves
 * the focus on the step's heading, never on the page behind.
 */
function StepPanel({ step, onBack }: { step: Step; onBack: () => void }) {
  const { t } = useShell();
  const { overview } = useFleet();
  const box = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const p = t.shell.palette;

  useEffect(() => {
    // The step's first control (the answer, the launch), not its back button.
    const first = box.current?.querySelector<HTMLElement>(
      ".sh-palette-step-body :is(button:not(:disabled), textarea, input:not([type='hidden']))",
    );
    (first ?? heading.current)?.focus();
    const rescue = new MutationObserver(() => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost) heading.current?.focus();
    });
    if (box.current) rescue.observe(box.current, { childList: true, subtree: true });
    return () => rescue.disconnect();
  }, []);

  let title: string;
  let body: ReactNode;
  if (step.kind === "launch") {
    const ticket = overview.ready.find((r) => r.project === step.project && r.id === step.ticket);
    title = p.launchTitle(step.ticket);
    body = ticket ? <LaunchStep ticket={ticket} /> : <p className="calm">{t.projectPages.launchSent}</p>;
  } else {
    title = p.answerTitle;
    const w = decisionCards(overview).find((d) => d.project === step.project && d.item === step.item);
    body = w ? <AnswerStep w={w} /> : <p className="calm">{p.decisionGone}</p>;
  }
  return (
    <div className="sh-palette-step" ref={box}>
      <div className="sh-palette-step-h">
        <button type="button" className="ui-button" onClick={onBack} aria-label={p.hints.back}>
          ←
        </button>
        <h2 ref={heading} tabIndex={-1}>
          {title}
        </h2>
      </div>
      <div className="sh-palette-step-body">{body}</div>
    </div>
  );
}

function LaunchStep({ ticket }: { ticket: ReturnType<typeof useFleet>["overview"]["ready"][number] }) {
  const { t } = useShell();
  const launch = useLaunch(ticket);
  const { error } = launch.req;
  return (
    <>
      <p className="sh-palette-step-title">
        <span className="mono faint">{ticket.id}</span> {ticket.title}
      </p>
      <LaunchControl ticket={ticket} launch={launch} />
      {error && (
        <p role="alert" style={{ color: "var(--critical)" }}>
          {t.requestErrors[error]}
        </p>
      )}
    </>
  );
}

function AnswerStep({ w }: { w: ReturnType<typeof decisionCards>[number] }) {
  const { t, author, setAuthor, account } = useShell();
  const { overview, failed, refresh, version } = useFleet();
  const now = useNow();
  const project = overview.projects.find((x) => x.slug === w.project);
  const ctx: ActionContext = {
    t,
    signer: { name: author, set: setAuthor, fixed: account !== null },
    live: overview.live.state === "ok" && !failed,
    now,
    version,
    refresh,
  };
  return (
    <>
      <p className="sh-palette-step-title">
        {w.ticket && <span className="mono faint">{w.ticket}</span>} {w.title}
      </p>
      <DecisionActions
        ctx={ctx}
        w={w}
        projectName={project?.name ?? w.project}
        coordinator={project?.coordinator.state ?? "unknown"}
        pr={null}
        sent={sentRequest(overview, w, null)}
      />
    </>
  );
}
