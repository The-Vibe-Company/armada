// The owner's field, docked at the bottom of the room (THE-1996), shaped like
// T3 Code's composer (THE-2051): a glass card in the thread's lane (THE-2050), a textarea
// that grows from two lines to `max-h-52`, Enter sends and Shift+Enter breaks
// the line, ↑ and ↓ walk the owner's earlier messages, the draft kept per
// project, the coordinator's model on the left and a round Send on the right;
// PageUp and PageDown scroll the thread above it (THE-2054).
// The text stays in the field until the daemon admitted it; a failure says why
// under it and keeps it for another try (the same message). The rules are
// `compose.ts`'s.
import { ArrowUp } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import type { WhenBusy } from "@/room/chat";
import {
  afterSend,
  browserStorage,
  caretLines,
  type DraftStorage,
  draftKeeper,
  draftOf,
  fieldHeight,
  keyIntent,
  type Recall,
  stepHistory,
  type Timers,
} from "@/room/compose";

/** What the primary slot is handed: the field's text, whether it is on its way, Send itself and the field's problem line. */
export interface ComposerField {
  text: string;
  sending: boolean;
  disabled: boolean;
  /** Sends the field; `queue` waits for the coordinator's turn to end. */
  submit: (whenBusy?: WhenBusy) => void;
  /** Says why an action failed, under the field. */
  fail: (problem: string) => void;
}

export function Composer({
  project,
  send,
  disabled,
  busy = false,
  hint,
  history = [],
  model = null,
  primary,
  restore = null,
  onPage,
  storage = browserStorage(),
  timers,
}: {
  project: string;
  send: (body: string, whenBusy?: WhenBusy) => Promise<void>;
  /** No coordinator, or no connection: the field says why below and sends nothing. */
  disabled: boolean;
  /** The coordinator is working (THE-2052): ⌘Enter queues the message for its turn's end. */
  busy?: boolean;
  hint: string | null;
  /** The owner's earlier messages of this project, newest first (↑ and ↓). */
  history?: readonly string[];
  /** The coordinator's model, a quiet label on the footer's left; nothing when unknown. */
  model?: string | null;
  /** Replaces the round Send (the live turn's Stop, Steer and Queue, THE-2052). */
  primary?: (field: ComposerField) => ReactNode;
  /** Messages a Stop withdrew (THE-2052): each new `key` puts their words back in the field, after what it holds. */
  restore?: { key: number; bodies: readonly string[] } | null;
  /** PageUp and PageDown from the field page the thread (THE-2054). */
  onPage?: (direction: "up" | "down") => void;
  /** Where drafts are kept (`localStorage`; null keeps none). */
  storage?: DraftStorage | null;
  timers?: Timers;
}) {
  const field = useId();
  const keeper = useMemo(() => (storage ? draftKeeper(storage, timers) : null), [storage, timers]);
  const [body, setBody] = useState(() => draftOf(storage, project));
  const [recall, setRecall] = useState<Recall | null>(null);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  // What the field holds now, for a send that resolves after the owner went on typing or walking.
  const latest = useRef({ body, recall });
  latest.current = { body, recall };
  // A recalled message puts the caret at its end, where ↓ goes on.
  const toEnd = useRef(false);

  // What a Stop withdrew comes back to the field, kept as the draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each Stop's key gives its words back once.
  useEffect(() => {
    if (!restore?.bodies.length) return;
    const back = [latest.current.body.trim(), ...restore.bodies].filter(Boolean).join("\n\n");
    toEnd.current = true;
    setBody(back);
    setRecall(null);
    keeper?.keep(project, back);
  }, [restore?.key]);

  // A draft still waiting is written when the room closes, or the page.
  useEffect(() => {
    if (!keeper) return;
    const flush = () => keeper.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [keeper]);

  // The field grows with its lines, from two (`rows`) to FIELD_MAX, then scrolls;
  // its lines wrap again when its width changes (the rail, the window).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the height follows the text.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    fit(el);
    if (toEnd.current) {
      toEnd.current = false;
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [body]);
  useEffect(() => {
    const el = area.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const blank = !body.trim();
  async function submit(whenBusy?: WhenBusy) {
    const text = body.trim();
    if (!text || sending || disabled) return;
    setSending(true);
    setProblem(null);
    try {
      await (whenBusy ? send(text, whenBusy) : send(text));
      // The field empties, or gives back the draft set aside to send an earlier message.
      const next = afterSend(text, latest.current.body, latest.current.recall);
      if (next !== null) {
        setBody(next);
        setRecall(null);
        if (next.trim()) keeper?.keep(project, next);
        else keeper?.drop(project);
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The message was not sent. Try again.");
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const el = event.currentTarget;
    const intent = keyIntent(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
      },
      { ...caretLines(el.value, el.selectionStart, el.selectionEnd), browsing: recall !== null },
    );
    if (!intent) return;
    if (intent === "send") {
      event.preventDefault();
      void submit(busy && (event.metaKey || event.ctrlKey) ? "queue" : undefined);
      return;
    }
    if (intent === "page-up" || intent === "page-down") {
      if (!onPage) return;
      event.preventDefault();
      onPage(intent === "page-up" ? "up" : "down");
      return;
    }
    const step = stepHistory(history, body, recall, intent);
    if (!step) return;
    event.preventDefault();
    toEnd.current = true;
    setBody(step.text);
    setRecall(step.recall);
  }

  const described = [hint && `${field}-hint`, problem && `${field}-problem`].filter(Boolean).join(" ");
  const fieldState: ComposerField = {
    text: body,
    sending,
    disabled,
    submit: (whenBusy) => void submit(whenBusy),
    fail: setProblem,
  };

  return (
    <form
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void submit();
      }}
      aria-label="Message the coordinator"
      className="flex-none bg-bg px-3 pt-2 pb-4 sm:px-12"
    >
      <div className="mx-auto w-full max-w-(--chat-content-max-width)">
        <div
          data-composer
          className="rounded-deck bg-card/85 shadow-control outline-blue/60 backdrop-blur-md transition-shadow focus-within:shadow-control-hover focus-within:outline-1"
        >
          <label htmlFor={`${field}-message`} className="sr-only">
            Message
          </label>
          <textarea
            id={`${field}-message`}
            ref={area}
            rows={2}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              // Editing a recalled message stops the walk; the draft stays aside (and kept) until it is sent.
              if (recall) setRecall({ ...recall, index: null });
              else keeper?.keep(project, event.target.value);
            }}
            onKeyDown={onKeyDown}
            maxLength={16 * 1024}
            autoComplete="off"
            placeholder="Tell the coordinator what to do."
            aria-describedby={described || undefined}
            disabled={disabled}
            className="block max-h-52 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-compose text-text outline-none placeholder:text-text-3 disabled:opacity-60"
          />
          <div className="flex items-center gap-3 px-3 pt-1 pb-2.5 pl-4">
            {model && (
              <span className="min-w-0 truncate font-mono text-body text-text-3" title="The coordinator's model">
                {model}
              </span>
            )}
            <span className="ml-auto flex flex-none items-center gap-2.5">
              {/* Present before it speaks, so a screen reader announces "Sending…". */}
              <span role="status" className="text-body text-text-3">
                {sending ? "Sending…" : ""}
              </span>
              {primary ? (
                primary(fieldState)
              ) : (
                <button
                  type="submit"
                  aria-label="Send"
                  disabled={disabled || sending || blank}
                  className={cn(
                    "grid size-8.5 cursor-pointer place-items-center rounded-full bg-text text-bg transition-transform ease-out",
                    "enabled:hover:scale-105 enabled:active:scale-95 disabled:cursor-default disabled:bg-fill-2 disabled:text-text-3",
                  )}
                >
                  <ArrowUp aria-hidden size={16} strokeWidth={2.25} />
                </button>
              )}
            </span>
          </div>
        </div>
        {hint && (
          <p id={`${field}-hint`} className="m-0 px-4 pt-2 text-body text-text-3">
            {hint}
          </p>
        )}
        {problem && (
          <p id={`${field}-problem`} role="alert" className="m-0 px-4 pt-2 text-body text-red">
            {problem}
          </p>
        )}
      </div>
    </form>
  );
}

/** Sizes the field to its content: two lines at least, FIELD_MAX at most, scrolling past it. */
function fit(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  const { height, scrolls } = fieldHeight(el.scrollHeight);
  el.style.height = `${height}px`;
  el.style.overflowY = scrolls ? "auto" : "hidden";
}
