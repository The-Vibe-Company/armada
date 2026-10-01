"use client";

// One decision of the overview (THE-867) as a card: a question and its
// choices, a plan to approve or amend, a hand-back to merge. Every button is a
// request in the coordinator's inbox (answerQuestion, changePlan,
// mergePullRequest), never an action: the card shows "sent to the
// coordinator" on the click, and puts the buttons back with the reason when
// the request is refused.
import type { CoordinatorState } from "@armada/core/read";
import Link from "next/link";
import { type KeyboardEvent, useRef, useState } from "react";
import { answerQuestion, changePlan, mergePullRequest } from "@/app/actions";
import { paths } from "@/lib/fleet-view";
import { type Decision, excerpt, orderOptions, type SentRequest } from "@/lib/overview-view";
import {
  type ActionContext,
  ErrorLine,
  PendingNote,
  QuestionBlock,
  SignerField,
  signerOf,
  splitQuestion,
  useRequest,
  useSent,
} from "../Actions";
import { Card, CardHead, CardMeta, CardTitle } from "../page";
import { Dot, Tag } from "../ui";

/** What an approval says on the ticket: tracker comments are in English. */
const APPROVED = "Approved.";
/** How much of a plan a card shows; the rest is on the ticket. */
const PLAN_EXCERPT = 280;

const KIND_COLOR: Record<Decision["kind"], string> = {
  question: "var(--accent)",
  approval: "var(--accent)",
  "hand-back": "var(--done)",
};

/** Sends the request the clicked button names. */
function send(form: FormData) {
  const action = form.get("action");
  if (action === "merge") return mergePullRequest(form);
  if (action === "changes") return changePlan(form);
  if (action === "approve") form.set("text", APPROVED);
  return answerQuestion(form);
}

interface DecisionProps {
  ctx: ActionContext;
  w: Decision;
  projectName: string;
  coordinator: CoordinatorState;
  /** For a hand-back: the pull request to merge. */
  pr: number | null;
  /** What the owner already asked, as the server holds it. */
  sent: SentRequest | null;
}

export function DecisionCard(props: DecisionProps) {
  const { ctx, w, projectName } = props;
  const { t, now } = ctx;
  const color = KIND_COLOR[w.kind];
  const age = Math.max(0, now - Date.parse(w.since));
  return (
    <Card>
      <CardHead
        icon={<Dot color={color} />}
        label={t.overview.kinds[w.kind]}
        color={color}
        side={<span title={w.since}>{t.ago(age)}</span>}
      />
      <CardTitle>
        {w.ticket ? (
          <Link href={paths.agent(w.ticket)} prefetch>
            {w.title ?? w.ticket}
          </Link>
        ) : (
          (w.title ?? projectName)
        )}
      </CardTitle>
      <CardMeta>
        <Tag>{projectName}</Tag>
        {w.ticket && <span className="mono">{w.ticket}</span>}
        {w.author && <span>{w.author}</span>}
        {w.coordinatorSince && (
          <span className="late">
            {t.coordinatorLate(t.duration(Math.max(0, now - Date.parse(w.coordinatorSince))))}
          </span>
        )}
      </CardMeta>
      <DecisionActions {...props} />
    </Card>
  );
}

/**
 * A decision's text and its buttons, as the overview's card and an agent's
 * page (THE-869) both show them: one click per choice of a question (the
 * recommended one first and primary), approve or amend a plan, ask to merge.
 * `full` shows a plan whole instead of its excerpt.
 */
export function DecisionActions({
  ctx,
  w,
  projectName,
  coordinator,
  pr,
  sent: held,
  full = false,
}: DecisionProps & { full?: boolean }) {
  const { t, now } = ctx;
  const [amending, setAmending] = useState(false);
  const [draft, setDraft] = useState("");
  const [sent, markSent, unmark] = useSent<SentRequest>(ctx.version);
  const shown = useRef<SentRequest | null>(null);
  const req = useRequest(send, {
    start: (form) => {
      const action = form.get("action");
      const body =
        action === "merge"
          ? t.overview.requestMerge
          : action === "approve"
            ? APPROVED
            : String(form.get("text") ?? "").trim();
      shown.current = { body, author: signerOf(ctx.signer, form), at: new Date(now).toISOString() };
      markSent(shown.current);
      setAmending(false);
    },
    done: () => {
      // Kept until two reads after the write, so the request never flickers away.
      if (shown.current) markSent(shown.current);
      setDraft("");
      ctx.refresh();
    },
    undo: () => unmark(),
  });
  const pending = held ?? sent;
  const canAct = ctx.live && !pending && (w.kind === "hand-back" ? pr !== null : w.item !== null);

  const { text, options } =
    w.kind === "question" ? splitQuestion(w.detail ?? "") : { text: w.detail ?? "", options: [] };
  const cut = w.kind === "approval" && !full;
  const body = cut ? excerpt(text, PLAN_EXCERPT) : text;

  const hidden = (
    <>
      <input type="hidden" name="project" value={w.project} />
      <input type="hidden" name="question" value={w.item ?? ""} />
      <input type="hidden" name="pr" value={pr ?? ""} />
    </>
  );
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    } else if (e.key === "Escape") setAmending(false);
  };

  return (
    <>
      {w.kind === "question" && options.length === 0 ? (
        // A question without choices: the answer is typed.
        <QuestionBlock
          ctx={ctx}
          project={w.project}
          ticket={w.ticket}
          item={w.item}
          body={w.detail ?? ""}
          answer={w.answer}
          coordinator={coordinator}
        />
      ) : (
        <>
          {/* The quote takes its decision's color: a hand-back is green, like its card. */}
          {body && (
            <p className="wait-detail is-quote" style={{ borderLeftColor: KIND_COLOR[w.kind] }}>
              {body}
            </p>
          )}
          {cut && w.url && text.length > PLAN_EXCERPT && (
            <a href={w.url} target="_blank" rel="noreferrer" className="link">
              {t.overview.readPlan}
            </a>
          )}
          {pending ? (
            <>
              {/* Refused because another request got there first: say why, next to it. */}
              <ErrorLine t={t} code={req.error} />
              <PendingNote
                label={t.overview.sent(projectName)}
                detail={t.overview.sentBy(pending.author, t.ago(Math.max(0, now - Date.parse(pending.at))))}
                quote={w.kind === "hand-back" ? `PR #${pr}` : `« ${pending.body} »`}
                away={coordinator === "active" ? null : t.coordinatorAway}
              />
            </>
          ) : amending ? (
            <form className="composer" onSubmit={req.submit}>
              {hidden}
              <input type="hidden" name="action" value="changes" />
              <textarea
                name="text"
                aria-label={t.overview.changesLabel(w.ticket ?? "")}
                placeholder={t.overview.changesPlaceholder}
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
                <button type="button" className="btn is-ghost" onClick={() => setAmending(false)}>
                  {t.cancel}
                </button>
                <button type="submit" className="btn is-primary" disabled={req.busy || !draft.trim()}>
                  {t.send}
                </button>
              </div>
            </form>
          ) : canAct ? (
            <form className="question" onSubmit={req.submit}>
              {hidden}
              {!ctx.signer.fixed && <SignerField t={t} signer={ctx.signer} />}
              <ErrorLine t={t} code={req.error} />
              <div className="composer-foot">
                {w.kind === "question" &&
                  orderOptions(options).map((o, k) => (
                    <button
                      key={o}
                      type="submit"
                      name="text"
                      value={o}
                      className={`btn ${k === 0 ? "is-primary" : "is-soft"}`}
                      disabled={req.busy}
                    >
                      {o}
                    </button>
                  ))}
                {w.kind === "approval" && (
                  <>
                    <button type="submit" name="action" value="approve" className="btn is-primary" disabled={req.busy}>
                      {t.overview.approvePlan}
                    </button>
                    <button
                      type="button"
                      className="btn is-soft"
                      onClick={() => {
                        req.clear();
                        setAmending(true);
                      }}
                    >
                      {t.overview.requestChanges}
                    </button>
                  </>
                )}
                {w.kind === "hand-back" && (
                  <button type="submit" name="action" value="merge" className="btn is-primary" disabled={req.busy}>
                    {t.overview.requestMerge}
                  </button>
                )}
              </div>
            </form>
          ) : !ctx.live ? (
            <p className="calm">{t.needsLive}</p>
          ) : (
            w.kind === "hand-back" && pr === null && <p className="calm">{t.overview.noPr}</p>
          )}
        </>
      )}
    </>
  );
}
