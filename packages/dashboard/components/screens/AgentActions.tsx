"use client";

// The request an agent's page makes beyond the overview's decisions
// (THE-869): ask the coordinator to release the ticket. Like the overview's
// actions (../Actions.tsx, DecisionCard.tsx), it only drops a request in the
// coordinator's inbox; it shows as pending until the coordinator resolves it,
// from the click on, and comes back with the reason if refused.
import type { CoordinatorState, InboxItem } from "@armada/core/read";
import { useRef, useState } from "react";
import type { RequestResult } from "@/lib/requests";
import { type ActionContext, ErrorLine, PendingNote, SignerField, signerOf, useRequest, useSent } from "../Actions";

/** A request waiting for the coordinator: the server's, or the one just sent. */
type Pending = { author: string | null; at: string };

export function RequestAction({
  ctx,
  label,
  what,
  send,
  fields,
  pending: recorded,
  coordinator,
  hint,
}: {
  ctx: ActionContext;
  /** The button: "Ask to release the ticket". */
  label: string;
  /** What the pending note says was asked: "Release asked". */
  what: string;
  send: (form: FormData) => Promise<RequestResult>;
  /** The form's hidden fields: project, ticket. */
  fields: Record<string, string | number>;
  /** The open request of this kind, from the overview. */
  pending: Pick<InboxItem, "author" | "createdAt"> | null;
  coordinator: CoordinatorState;
  /** What confirming does, shown before the confirm button. */
  hint?: string;
}) {
  const { t } = ctx;
  const [open, setOpen] = useState(false);
  const [sent, markSent, unmark] = useSent<Pending>(ctx.version);
  const shown = useRef<Pending | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const req = useRequest(send, {
    start: (form) => {
      shown.current = { author: signerOf(ctx.signer, form), at: new Date().toISOString() };
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
  const pending: Pending | null = recorded ? { author: recorded.author, at: recorded.createdAt } : sent;
  if (pending)
    return (
      <PendingNote
        label={t.shell.agent.pending(what, pending.author, t.duration(Math.max(0, ctx.now - Date.parse(pending.at))))}
        detail={t.waitingForCoordinator}
        away={coordinator === "active" ? null : t.coordinatorAway}
      />
    );
  if (!ctx.live) return null;
  if (!open)
    return (
      <button ref={opener} type="button" className="btn is-soft" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  const close = () => {
    setOpen(false);
    req.clear();
    requestAnimationFrame(() => opener.current?.focus());
  };
  return (
    <form className="composer" onSubmit={req.submit}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {hint && <p className="calm">{hint}</p>}
      <ErrorLine t={t} code={req.error} />
      <div className="composer-foot">
        <SignerField t={t} signer={ctx.signer} />
        <span className="spacer" />
        <button type="button" className="btn is-ghost" onClick={close}>
          {t.cancel}
        </button>
        <button type="submit" className="btn is-primary" disabled={req.busy}>
          {req.busy ? t.sending : t.shell.agent.confirm}
        </button>
      </div>
    </form>
  );
}
