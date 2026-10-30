// The coordinator's turn as it happens (THE-2052), after T3 Code's thread
// (`TimelineWorkGroupRows.tsx`, `ComposerPrimaryActions.tsx`): the Working row
// with its timer at the end of the thread, the Thinking row with its shimmer
// and its first line, the stopped mark under an interrupted answer, the
// messages queued for the turn's end, and the composer's Stop, Steer and Queue.
import type { ChatItem } from "@armada/protocol";
import { Brain, CornerUpRight, ListPlus } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { ComposerField } from "./Composer";
import { Markdown } from "./Markdown";

/**
 * A thought's one line while it is closed (T3 Code's `liveThoughtLine`): its
 * first bold heading, else its first sentence, without markdown's marks.
 */
export function liveThoughtLine(markdown: string): string {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (heading !== undefined) return text;
  const end = /[.?!]["'”’)]?(?=\s)/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}

/** How long the turn has worked, as T3 Code says it: `12s`, then `1m 5s`, `1h 2m`. */
export function workingTimer(since: string, now: number): string {
  const start = Date.parse(since);
  if (!Number.isFinite(start)) return "0s";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const parts = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  return parts
    .map((n, k) => (n > 0 ? `${n}${"hms"[k]}` : ""))
    .filter(Boolean)
    .join(" ");
}

/**
 * Runs an element's shimmer only while it is on screen and the page is shown
 * (`--visible-animation-state`, read by `live-shine`); reduced motion turns
 * the shimmer off in the stylesheet.
 */
function useVisibleAnimation<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    let seen = false;
    const update = () =>
      el.style.setProperty(
        "--visible-animation-state",
        seen && document.visibilityState === "visible" ? "running" : "paused",
      );
    update();
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      seen = entries.some((e) => e.isIntersecting);
      update();
    });
    observer.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [active]);
  return ref;
}

/** Words that shimmer while `active` (T3 Code's `live-tool-shine`), plain otherwise. */
export function Shine({ active, children }: { active: boolean; children: ReactNode }) {
  const ref = useVisibleAnimation<HTMLSpanElement>(active);
  if (!active) return children;
  return (
    <span ref={ref} className="live-shine" data-shine>
      {children}
    </span>
  );
}

/** The last line of a thread while the coordinator works: "Working for 12s", or "Working…" joined mid-way. */
export function Working({ started, queued }: { started: string | null; queued: number }) {
  // Each second draws it again; any other render reads the time afresh too.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!started) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [started]);
  const now = Date.now();
  return (
    // The border holds the line's place: the thread does not move when the turn ends.
    <div className="border-line border-b pt-1 pb-2" data-working>
      <p className="m-0 flex h-6 min-w-0 items-baseline gap-2 px-1 text-body text-text-3 tnum">
        <span className="whitespace-nowrap">
          {started ? (
            <>
              Working for <span data-timer>{workingTimer(started, now)}</span>
            </>
          ) : (
            "Working…"
          )}
        </span>
        {queued > 0 && <span data-queued-count>· {queued} queued</span>}
      </p>
    </div>
  );
}

/**
 * The coordinator's reasoning: a brain and "Thinking" shimmering while it
 * thinks ("Thought" after), its first line under it; a click opens it as
 * markdown, held at its end while it is still written.
 */
export function Thought({
  reasoning,
  active,
  repository,
  prefixes,
}: {
  reasoning: string;
  active: boolean;
  repository: string;
  prefixes: string;
}) {
  const [open, setOpen] = useState(false);
  const body = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const preview = liveThoughtLine(reasoning);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new word of an open, live thought keeps its end in view.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && active) el.scrollTop = el.scrollHeight;
  }, [open, active, reasoning]);
  return (
    <div className="min-w-0" data-thought={active ? "live" : "done"}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? body : undefined}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 cursor-pointer flex-col items-start gap-0.5 rounded-md px-1 text-left text-body text-text-3 hover:text-text-2"
      >
        <span className="inline-flex h-6 items-center gap-2">
          <Brain aria-hidden size={14} strokeWidth={2} className="flex-none" />
          <Shine active={active}>{active ? "Thinking" : "Thought"}</Shine>
        </span>
        {!open && preview && (
          <span className="line-clamp-4 pl-5.5 text-text-2" data-preview>
            {preview}
          </span>
        )}
      </button>
      {open && (
        <div id={body} ref={scroller} className="mt-1 mb-1 ml-6.5 max-h-96 overflow-y-auto pr-2" data-reasoning>
          <Markdown text={reasoning} repository={repository} prefixes={prefixes} className="text-text-2" />
        </div>
      )}
    </div>
  );
}

/**
 * Under an answer the owner interrupted: a "stopped" pill, and T3 Code's
 * sentence unless the fold of its work above already says it (`said`).
 */
export function Stopped({ said }: { said: boolean }) {
  return (
    <p className="m-0 flex items-center gap-2 px-1 text-body text-text-3" data-stopped>
      <span className="rounded-xs bg-fill-2 px-1.5 font-mono text-meta text-text-2">stopped</span>
      {said && "You stopped this response"}
    </p>
  );
}

/** The owner's messages waiting for the turn's end: faded, on the right, between the thread and the field. */
export function Queued({ items }: { items: readonly ChatItem[] }) {
  if (!items.length) return null;
  return (
    <section aria-label="Queued messages" className="flex-none px-3 pb-1 sm:px-12" data-queued>
      <ol className="m-0 mx-auto flex w-full max-w-(--chat-content-max-width) list-none flex-col items-end gap-1.5 p-0">
        {items.map((item) => (
          <li
            key={item.id}
            className="max-w-[80%] truncate rounded-deck bg-panel-3 px-3 py-1.5 text-body text-text-2 opacity-60 shadow-ring"
          >
            <span className="sr-only">Queued: </span>
            {"body" in item ? item.body : ""}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Whether ⌘ (or Ctrl) is held: the Steer button shows that a click would queue. */
function useModifier() {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => setHeld(e.metaKey || e.ctrlKey);
    const off = () => setHeld(false);
    window.addEventListener("keydown", on);
    window.addEventListener("keyup", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener("keyup", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  return held;
}

const ROUND =
  "grid size-8.5 cursor-pointer place-items-center rounded-full transition-transform ease-out enabled:hover:scale-105 enabled:active:scale-95 disabled:cursor-default";

/**
 * The composer's round button while the coordinator works: Stop with an empty
 * field; with text, Steer (the message joins the running work), or Queue on
 * ⌘-click (it waits for the turn's end).
 */
export function TurnActions({ field, stop }: { field: ComposerField; stop: () => Promise<void> }) {
  const [stopping, setStopping] = useState(false);
  const queue = useModifier();
  if (!field.text.trim())
    return (
      <button
        type="button"
        aria-label="Stop generation"
        title="Interrupt"
        disabled={field.disabled || stopping}
        onClick={() => {
          setStopping(true);
          stop()
            .catch((error: unknown) => field.fail(error instanceof Error ? error.message : "Could not stop it."))
            .finally(() => setStopping(false));
        }}
        className={cn(ROUND, "bg-red text-bg disabled:opacity-60")}
        data-stop
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </button>
    );
  return (
    <button
      type="submit"
      aria-label={queue ? "Queue message" : "Steer message"}
      title="Click to steer, ⌘-click to queue"
      disabled={field.disabled || field.sending}
      onClick={(event) => {
        if (!event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        field.submit("queue");
      }}
      className={cn(ROUND, "bg-text text-bg disabled:bg-fill-2 disabled:text-text-3")}
    >
      {queue ? (
        <ListPlus aria-hidden size={16} strokeWidth={2.25} />
      ) : (
        <CornerUpRight aria-hidden size={16} strokeWidth={2.25} />
      )}
    </button>
  );
}
