"use client";

// The owner's two actions on the Fleet view: answer a worker's question, and
// ask for a ready ticket to be launched. Each only drops a request in the
// coordinator's inbox (a server action); the coordinator carries it out, and
// the request shows as pending until it does. The screen changes on the
// click, before the server answers (THE-853); a refusal puts the form back
// with the reason.
import type { CoordinatorState, PendingAnswer, ProfileSummary, ReadyTicket } from "@armada/core/read";
import { type FormEvent, type KeyboardEvent, useId, useRef, useState, useTransition } from "react";
import { answerQuestion, launchTicket } from "@/app/actions";
import type { RequestError, Strings } from "@/lib/i18n";
import type { RequestResult } from "@/lib/requests";

/** The viewer's name, which signs every request of the page. */
export interface Signer {
  name: string;
  set: (name: string) => void;
  /** The signed-in person signs (accounts): the server ignores any name in the form, so none is asked. */
  fixed: boolean;
}

/** What the page tells each action: whether requests can be written, and how to refresh after one. */
export interface ActionContext {
  t: Strings;
  signer: Signer;
  /** The live data is read: requests can be written, and their pending state is visible. */
  live: boolean;
  now: number;
  /** Increases with every overview read; a request just sent shows locally until the server has it. */
  version: number;
  refresh: () => void;
}

const since = (now: number, iso: string) => Math.max(0, now - Date.parse(iso));

/** A question as core stores it: the text, then "Options:" and a numbered list (see `questionBody`). */
export function splitQuestion(body: string): { text: string; options: string[] } {
  const marker = "\n\nOptions:\n";
  const at = body.lastIndexOf(marker);
  if (at < 0) return { text: body, options: [] };
  const options = body
    .slice(at + marker.length)
    .split("\n")
    .map((l) => l.match(/^\d+\.\s+(.+)$/)?.[1]?.trim() ?? "")
    .filter(Boolean);
  return options.length ? { text: body.slice(0, at), options } : { text: body, options: [] };
}

/** What a request does to the screen: at once on submit, once recorded, and back if refused. */
interface RequestSteps {
  start: (form: FormData) => void;
  done: (form: FormData) => void;
  undo: () => void;
}

/** Runs one request optimistically; keeps its error code when refused. */
function useRequest(send: (form: FormData) => Promise<RequestResult>, steps: RequestSteps) {
  const [busy, start] = useTransition();
  const [error, setError] = useState<RequestError | null>(null);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    steps.start(form);
    start(async () => {
      const result: RequestResult = await send(form).catch(() => ({
        ok: false as const,
        code: "failed" as const,
        message: "",
      }));
      if (result.ok) steps.done(form);
      else {
        steps.undo();
        setError(result.code);
      }
    });
  };
  return { busy, error, submit, clear: () => setError(null) };
}

/** A request the server has not shown yet: kept for two overview reads after it was recorded (one may have started before). */
function useSent<T>(version: number) {
  const [sent, setSent] = useState<(T & { version: number }) | null>(null);
  // The version when the write returned, not when the form was rendered.
  const latest = useRef(version);
  latest.current = version;
  const current = sent && version < sent.version + 2 ? sent : null;
  return [current, (value: T) => setSent({ ...value, version: latest.current }), () => setSent(null)] as const;
}

/** Who the request just sent was signed by; a typed name is remembered for the next one. */
function signerOf(signer: Signer, form: FormData): string {
  if (signer.fixed) return signer.name;
  const typed = String(form.get("author") ?? "");
  signer.set(typed);
  return typed;
}

function SignerField({ t, signer }: { t: Strings; signer: Signer }) {
  const [editing, setEditing] = useState(!signer.name && !signer.fixed);
  const id = useId();
  if (signer.fixed)
    return (
      <span className="signer">
        {t.signedAs} <b>{signer.name}</b>
      </span>
    );
  if (!editing)
    return (
      <span className="signer">
        {t.signedAs} <b>{signer.name}</b>
        <input type="hidden" name="author" value={signer.name} />
        <button type="button" className="link" onClick={() => setEditing(true)}>
          {t.change}
        </button>
      </span>
    );
  return (
    <span className="signer">
      <label htmlFor={id} className="sr-only">
        {t.yourName}
      </label>
      <input
        id={id}
        className="name-input"
        name="author"
        defaultValue={signer.name}
        placeholder={t.yourName}
        title={t.nameHint}
        required
        maxLength={80}
        autoComplete="name"
      />
    </span>
  );
}

function ErrorLine({ t, code }: { t: Strings; code: RequestError | null }) {
  if (!code) return null;
  return (
    <p className="req-error" role="alert">
      {t.requestErrors[code]}
    </p>
  );
}

function PendingNote({
  label,
  detail,
  quote,
  away,
}: {
  label: string;
  detail: string;
  quote?: string | null;
  away: string | null;
}) {
  return (
    <div className="pending" role="status">
      <span className="pending-dot" aria-hidden />
      <div className="pending-text">
        <span>
          <b>{label}</b> · {detail}
        </span>
        {quote && <span className="pending-quote">{quote}</span>}
        {away && <span className="faint">{away}</span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ answer

export function QuestionBlock({
  ctx,
  project,
  ticket,
  item,
  body,
  answer,
  coordinator,
  approval = false,
}: {
  ctx: ActionContext;
  project: string;
  ticket: string | null;
  /** The question's inbox item id; null when it cannot be answered from here. */
  item: number | null;
  body: string;
  answer: PendingAnswer | null;
  coordinator: CoordinatorState;
  approval?: boolean;
}) {
  const { t } = ctx;
  const { text, options } = approval ? { text: body, options: [] } : splitQuestion(body);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sent, markSent, unmark] = useSent<PendingAnswer>(ctx.version);
  const opener = useRef<HTMLButtonElement>(null);
  const shown = useRef<PendingAnswer | null>(null);
  const req = useRequest(answerQuestion, {
    start: (form) => {
      shown.current = { id: 0, body: draft.trim(), author: signerOf(ctx.signer, form), at: new Date().toISOString() };
      markSent(shown.current);
      setOpen(false);
    },
    done: () => {
      // Kept until two reads after the write, so the answer never flickers away.
      if (shown.current) markSent(shown.current);
      setDraft("");
      ctx.refresh();
    },
    undo: () => {
      unmark();
      setOpen(true);
    },
  });
  const pending = answer ?? sent;
  const canAnswer = ctx.live && item !== null && !pending;

  const start = (value: string) => {
    setDraft(value);
    req.clear();
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    req.clear();
    requestAnimationFrame(() => opener.current?.focus());
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    } else if (e.key === "Escape") close();
  };

  return (
    <div className="question">
      <p className="wait-detail is-quote" style={approval ? { whiteSpace: "pre-wrap" } : undefined}>
        {text}
      </p>
      {options.length > 0 && (
        <ul className="chips">
          {options.map((o, k) => (
            <li key={o}>
              {canAnswer && !open ? (
                <button type="button" className="chip" aria-label={`${t.quickAnswer}: ${o}`} onClick={() => start(o)}>
                  <span className="chip-n tnum">{k + 1}</span>
                  {o}
                </button>
              ) : (
                <span className="chip is-static">
                  <span className="chip-n tnum">{k + 1}</span>
                  {o}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {pending ? (
        <PendingNote
          label={t.answerPending(pending.author, t.duration(since(ctx.now, pending.at)))}
          detail={t.waitingForCoordinator}
          quote={pending.body}
          away={coordinator === "active" ? null : t.coordinatorAway}
        />
      ) : canAnswer && open ? (
        <form className="composer" onSubmit={req.submit}>
          <input type="hidden" name="project" value={project} />
          <input type="hidden" name="question" value={item ?? ""} />
          <textarea
            name="text"
            aria-label={approval ? t.approvalLabel(ticket ?? "") : t.answerLabel(ticket ?? "")}
            placeholder={t.answerPlaceholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={keys}
            rows={3}
            maxLength={4000}
            required
            // biome-ignore lint/a11y/noAutofocus: the box opens on the owner's click, to be typed in
            autoFocus
          />
          <ErrorLine t={t} code={req.error} />
          <div className="composer-foot">
            <SignerField t={t} signer={ctx.signer} />
            <span className="spacer" />
            <button type="button" className="btn is-ghost" onClick={close}>
              {t.cancel}
            </button>
            <button type="submit" className="btn is-primary" disabled={req.busy || !draft.trim()}>
              {req.busy ? t.sending : t.send}
              <kbd className="kbd" aria-hidden>
                ⌘↵
              </kbd>
            </button>
          </div>
        </form>
      ) : (
        canAnswer && (
          <button
            ref={opener}
            type="button"
            className="btn is-soft answer-btn"
            onClick={() => start(approval ? "approved" : "")}
          >
            {approval ? t.approve : t.answer}
          </button>
        )
      )}
    </div>
  );
}

// ------------------------------------------------------------ launch

export function ReadyBlock({
  ctx,
  ready,
  profiles,
  names,
  coordinators,
}: {
  ctx: ActionContext;
  ready: ReadyTicket[];
  profiles: Map<string, ProfileSummary[]>;
  names: Map<string, string>;
  coordinators: Map<string, CoordinatorState>;
}) {
  const { t } = ctx;
  const [all, setAll] = useState(false);
  const marked = ready.filter((r) => r.readyForAgent || r.launch);
  const others = ready.filter((r) => !r.readyForAgent && !r.launch);
  const shown = all ? [...marked, ...others] : marked;
  return (
    <section className="block" aria-labelledby="ready-h">
      <div className="block-h">
        <h2 id="ready-h" className="serif">
          {t.readyTitle}
        </h2>
        <span className="count tnum">{marked.length}</span>
        <span className="block-hint">{t.readyHint}</span>
      </div>
      {!ctx.live && ready.length > 0 && <p className="calm">{t.needsLive}</p>}
      {shown.length === 0 && others.length === 0 ? (
        <p className="calm">{t.readyEmpty}</p>
      ) : (
        <>
          {shown.length > 0 && (
            <ol className="ready">
              {shown.map((r, k) => (
                <ReadyRow
                  key={`${r.project}-${r.id}`}
                  ctx={ctx}
                  r={r}
                  profiles={profiles.get(r.project) ?? []}
                  projectName={names.get(r.project) ?? r.project}
                  coordinator={coordinators.get(r.project) ?? "unknown"}
                  i={k}
                />
              ))}
            </ol>
          )}
          {others.length > 0 && (
            <button type="button" className="link ready-more" onClick={() => setAll(!all)} aria-expanded={all}>
              {all ? t.fewerUnblocked : t.moreUnblocked(others.length)}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function ReadyRow({
  ctx,
  r,
  profiles,
  projectName,
  coordinator,
  i,
}: {
  ctx: ActionContext;
  r: ReadyTicket;
  profiles: ProfileSummary[];
  projectName: string;
  coordinator: CoordinatorState;
  i: number;
}) {
  const { t } = ctx;
  const routed = r.route?.profile ?? null;
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState(routed ?? profiles[0]?.name ?? "");
  type Launch = { author: string; at: string; profile: string | null };
  const [sent, markSent, unmark] = useSent<Launch>(ctx.version);
  const opener = useRef<HTMLButtonElement>(null);
  const shown = useRef<Launch | null>(null);
  const panel = useId();
  const req = useRequest(launchTicket, {
    start: (form) => {
      shown.current = { author: signerOf(ctx.signer, form), at: new Date().toISOString(), profile: profile || null };
      markSent(shown.current);
      setOpen(false);
    },
    done: () => {
      if (shown.current) markSent(shown.current);
      ctx.refresh();
    },
    undo: () => {
      unmark();
      setOpen(true);
    },
  });
  const pending = r.launch ?? sent;
  const close = () => {
    setOpen(false);
    req.clear();
    requestAnimationFrame(() => opener.current?.focus());
  };

  return (
    <li
      className={`ready-row ${open ? "is-open" : ""} ${pending ? "is-pending" : ""}`}
      style={{ ["--i" as string]: i }}
    >
      <div className="ready-main">
        <a className="crew-title" href={r.url} target="_blank" rel="noreferrer">
          {r.title}
        </a>
        <div className="meta">
          <span className="tag">{projectName}</span>
          <span className="mono">{r.id}</span>
          {r.spec && <span>{r.spec}</span>}
          {r.onCriticalPath && <span className="flag is-severe">{t.criticalPath}</span>}
          {r.unlocks.length > 0 && <span title={r.unlocks.join(", ")}>{t.unlocks(r.unlocks.length)}</span>}
          {!r.readyForAgent && <span className="faint">{t.notMarkedReady}</span>}
          {routed && !pending && (
            <span className="mono faint" title={t.routedHint(r.route?.why ?? "")}>
              → {routed}
            </span>
          )}
        </div>
      </div>
      <div className="ready-act">
        {pending ? (
          <PendingNote
            label={t.launchPending(pending.author, t.duration(since(ctx.now, pending.at)))}
            detail={pending.profile ?? t.waitingForCoordinator}
            away={coordinator === "active" ? null : t.coordinatorAway}
          />
        ) : (
          ctx.live &&
          !open && (
            <button
              ref={opener}
              type="button"
              className="btn is-soft"
              aria-expanded={false}
              aria-controls={panel}
              aria-label={t.launchLabel(r.id)}
              onClick={() => setOpen(true)}
            >
              {t.launch}
              <span aria-hidden>→</span>
            </button>
          )
        )}
      </div>
      {open && !pending && (
        <form id={panel} className="launch-panel" onSubmit={req.submit}>
          <input type="hidden" name="project" value={r.project} />
          <input type="hidden" name="ticket" value={r.id} />
          {profiles.length ? (
            <fieldset className="profiles">
              <legend className="sr-only">{t.profile}</legend>
              {profiles.map((p) => (
                <label key={p.name} className={`profile-opt ${profile === p.name ? "is-on" : ""}`}>
                  <input
                    type="radio"
                    name="profile"
                    value={p.name}
                    checked={profile === p.name}
                    onChange={() => setProfile(p.name)}
                  />
                  <span className="profile-name">
                    {p.name}
                    {p.name === routed && (
                      <span className="badge" title={t.routedHint(r.route?.why ?? "")}>
                        {t.routed}
                      </span>
                    )}
                  </span>
                  <span className="profile-spec mono">
                    {p.agent} · {p.model} · {p.effort}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : (
            <p className="calm">{t.noProfiles}</p>
          )}
          {routed && profile && profile !== routed && <p className="calm">{t.overrideHint(routed)}</p>}
          <ErrorLine t={t} code={req.error} />
          <div className="composer-foot">
            <SignerField t={t} signer={ctx.signer} />
            <span className="spacer" />
            <button type="button" className="btn is-ghost" onClick={close}>
              {t.cancel}
            </button>
            <button type="submit" className="btn is-primary" disabled={req.busy}>
              {req.busy ? t.sending : t.requestLaunch}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
