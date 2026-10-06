"use client";

// Shared validation decisions for the owner pages and session previews.
// Keep this entry independent of the detail card's gallery and Next Image.
import type { OwnerValidation } from "@armada/core/read";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { decideValidation } from "@/app/actions";
import { saveRequestedSecret } from "@/app/keys-actions";
import { CHOICE_KEYS, type KeyAction, type KeyPress, pressOf, validationKey } from "@/lib/validation-keys";
import { type ActionContext, ErrorLine, PendingNote, SignerField, signerOf, useRequest, useSent } from "../Actions";
import { Button, Form, Input } from "../page";
import { useShell } from "../shell/context";

/** A decision as shown once sent, before the overview has it. */
export interface Sent {
  body: string;
  author: string | null;
  at: string;
}

/** What the Validations page's keys reach of the open validation: true when a key decided something. */
export interface DecideKeys {
  press: (key: KeyPress) => boolean;
}

/**
 * The owner's buttons: Approve (the merge) and Request changes, or the
 * choices the validation was sent with. `note` (the Validations page) puts a
 * note for the coordinator above them, sent with any decision and required
 * to request changes; without it, Request changes opens its own box. Shown
 * as sent at once; back with the reason when refused.
 */
export function Decide(props: Parameters<typeof DecideWork>[0]) {
  return props.v.kind === "secret" ? (
    <SecretRequest key={props.v.id} ctx={props.ctx} v={props.v} />
  ) : (
    <DecideWork {...props} />
  );
}

/** The value stays in an uncontrolled password input and is cleared on submission. */
function SecretRequest({ ctx, v }: { ctx: ActionContext; v: OwnerValidation }) {
  const { account } = useShell();
  const s = ctx.t.validations.secret;
  const field = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState(false);
  const req = useRequest(saveRequestedSecret, {
    start: () => {
      if (field.current) field.current.value = "";
    },
    done: () => {
      setSaved(true);
      ctx.refresh();
    },
    undo: () => {},
  });
  if (saved)
    return (
      <p className="calm" role="status">
        {s.saved}
      </p>
    );
  if (!account?.canSetSecrets) return <p className="calm">{s.manager}</p>;
  if (!ctx.live) return <p className="calm">{ctx.t.needsLive}</p>;
  return (
    <Form onSubmit={req.submit} aria-label={s.form}>
      <input type="hidden" name="project" value={v.project} />
      <input type="hidden" name="validation" value={v.id} />
      <label htmlFor={`secret-${v.id}`} className="mono">
        {v.secretName}
      </label>
      <Input
        ref={field}
        id={`secret-${v.id}`}
        name="value"
        type="password"
        required
        maxLength={32768}
        autoComplete="new-password"
        disabled={req.busy}
      />
      <p className="calm">{s.hint}</p>
      <ErrorLine t={ctx.t} code={req.error} />
      <Button tone="primary" disabled={req.busy}>
        {s.save}
      </Button>
    </Form>
  );
}

function DecideWork({
  ctx,
  v,
  projectName,
  changes = true,
  note = false,
  keys,
  onDone,
  sentBefore = null,
  children,
}: {
  ctx: ActionContext;
  v: OwnerValidation;
  projectName: string;
  /** Offer "Request changes" here; the overview's pane leaves it to the validation's page. */
  changes?: boolean;
  /** A note box above the buttons (the Validations page). */
  note?: boolean;
  /** The page's keys (the Validations page, with the note): A, C, 1–6, then ⌘↵ or Esc in the note. */
  keys?: Ref<DecideKeys>;
  /** Called once the decision is recorded, with what was sent. */
  onDone?: (sent: Sent) => void;
  /** Already sent from this tab: shown as sent, no buttons. */
  sentBefore?: Sent | null;
  /** More buttons, after the decision's (the overview's pane: the validation's page). */
  children?: ReactNode;
}) {
  const { t, now } = ctx;
  const s = t.validations;
  const [changing, setChanging] = useState(false);
  const [draft, setDraft] = useState("");
  const [missing, setMissing] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [justSent, markSent, unmark] = useSent<Sent>(ctx.version);
  const sent = justSent ?? sentBefore;
  const shown = useRef<Sent | null>(null);
  const req = useRequest(decideValidation, {
    start: (form) => {
      const action = form.get("action");
      const typed = String(form.get("note") ?? "").trim();
      const body =
        action === "approve"
          ? v.kind === "merge"
            ? s.approveMerge
            : s.approve
          : action === "choice"
            ? String(form.get("choice") ?? "")
            : typed;
      shown.current = { body, author: signerOf(ctx.signer, form), at: new Date(now).toISOString() };
      markSent(shown.current);
      setChanging(false);
    },
    done: () => {
      if (shown.current) markSent(shown.current);
      setDraft("");
      ctx.refresh();
      if (shown.current) onDone?.(shown.current);
    },
    undo: () => unmark(),
  });
  // With the note box, `changing` is C's: the note has the focus, and ⌘↵ sends the changes.
  const keyState = { open: !sent && ctx.live && !req.busy, choices: v.choices?.length ?? 0, changing };
  const run = (action: KeyAction) => {
    const element = form.current;
    if (!element) return;
    // The same submit as the button's click: its value is the decision.
    const submit = (selector: string, index = 0) => {
      const button = element.querySelectorAll<HTMLButtonElement>(selector)[index];
      if (button) element.requestSubmit(button);
    };
    if (action.kind === "approve") submit('button[value="approve"]');
    else if (action.kind === "send") submit('button[value="changes"]');
    else if (action.kind === "choice") submit('button[name="choice"]', action.index);
    else if (action.kind === "changes") {
      req.clear();
      setChanging(true);
      box.current?.focus();
    } else {
      setChanging(false);
      box.current?.blur();
    }
  };
  useImperativeHandle(keys, () => ({
    press: (key) => {
      // Hidden (the list alone, on a phone): the keys decide nothing unseen.
      if (!form.current?.getClientRects().length) return false;
      const action = validationKey(key, keyState);
      if (action) run(action);
      return action !== null;
    },
  }));
  const hidden = (
    <>
      <input type="hidden" name="project" value={v.project} />
      <input type="hidden" name="validation" value={v.id} />
    </>
  );
  if (sent)
    return (
      <PendingNote
        label={s.sent}
        detail={t.overview.sentBy(sent.author, t.ago(Math.max(0, now - Date.parse(sent.at))))}
        quote={`« ${sent.body} »`}
        away={null}
      />
    );
  if (!ctx.live) return <p className="calm">{t.needsLive}</p>;
  const typed = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The note box sends with ⌘↵ only after C: otherwise its decision is the button the owner clicks.
    if (note) {
      const action = validationKey(pressOf(e, "note"), keyState);
      if (action) {
        e.preventDefault();
        run(action);
      }
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    } else if (e.key === "Escape") setChanging(false);
  };
  if (changing && !note)
    return (
      <form className="composer" onSubmit={req.submit}>
        {hidden}
        <input type="hidden" name="action" value="changes" />
        <textarea
          name="note"
          aria-label={s.changesLabel(v.ticket)}
          placeholder={s.changesPlaceholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={typed}
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
          <button type="button" className="btn is-ghost" onClick={() => setChanging(false)}>
            {t.cancel}
          </button>
          <button type="submit" className="btn is-primary" disabled={req.busy || !draft.trim()}>
            {t.send}
          </button>
        </div>
      </form>
    );
  // With the note box, "Request changes" needs its words there.
  const submit = (e: FormEvent<HTMLFormElement>) => {
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (note && submitter?.value === "changes" && !draft.trim()) {
      e.preventDefault();
      setMissing(true);
      setChanging(true);
      box.current?.focus();
      return;
    }
    req.submit(e);
  };
  return (
    <form
      ref={form}
      className="question vd-decide"
      onSubmit={submit}
      aria-label={`${s.kinds[v.kind]} · ${projectName}`}
    >
      {hidden}
      {note && (
        <>
          <textarea
            ref={box}
            name="note"
            className="vd-note"
            aria-label={s.noteLabel(v.ticket)}
            aria-invalid={missing || undefined}
            aria-describedby={missing ? `validation-note-${v.id}` : undefined}
            placeholder={s.note}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setMissing(false);
            }}
            onKeyDown={typed}
            rows={2}
            maxLength={4000}
          />
          {missing ? (
            <p className="req-error" id={`validation-note-${v.id}`} role="alert">
              {s.changesNeedNote}
            </p>
          ) : (
            changing && <p className="vd-hint">{s.keys.send}</p>
          )}
        </>
      )}
      {!ctx.signer.fixed && <SignerField t={t} signer={ctx.signer} />}
      <ErrorLine t={t} code={req.error} />
      <div className="vd-actions">
        {v.choices ? (
          <>
            <input type="hidden" name="action" value="choice" />
            {v.choices.map((c, k) => (
              <button
                key={c}
                type="submit"
                name="choice"
                value={c}
                className={`btn ${k === 0 ? "is-primary" : "is-soft"}`}
                disabled={req.busy}
                aria-keyshortcuts={keys && k < CHOICE_KEYS ? String(k + 1) : undefined}
              >
                {c}
                {keys && k < CHOICE_KEYS && <Key>{k + 1}</Key>}
              </button>
            ))}
          </>
        ) : (
          <>
            <button
              type="submit"
              name="action"
              value="approve"
              className="btn is-primary"
              disabled={req.busy}
              aria-keyshortcuts={keys ? "A" : undefined}
            >
              {v.kind === "merge" ? s.approveMerge : s.approve}
              {keys && <Key>A</Key>}
            </button>
            {changes &&
              (note ? (
                <button
                  type="submit"
                  name="action"
                  value="changes"
                  className="btn is-soft"
                  disabled={req.busy}
                  aria-keyshortcuts={keys ? "C" : undefined}
                >
                  {s.requestChanges}
                  {keys && <Key>C</Key>}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn is-soft"
                  onClick={() => {
                    req.clear();
                    setChanging(true);
                  }}
                >
                  {s.requestChanges}
                </button>
              ))}
          </>
        )}
        {children}
      </div>
    </form>
  );
}

/** A button's key, beside its words; screen readers read `aria-keyshortcuts` instead. */
const Key = ({ children }: { children: ReactNode }) => (
  <kbd className="kbd" aria-hidden>
    {children}
  </kbd>
);
