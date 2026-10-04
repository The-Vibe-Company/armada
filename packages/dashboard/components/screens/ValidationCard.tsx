"use client";

// One thing the owner validates (THE-885), as the Validations page, the
// approval link (/approve/<id>) and a session's page show it:
// what to check and why, the pull request with its files, CI and preview, the
// screenshots and links, and the owner's buttons. Each button is a request:
// the decision lands in the coordinator's inbox, which merges or relays it.
// `full` is the approval page and a session to validate (every file, every
// attachment, its images full width, THE-916).
import type { Attachment, CiState, OwnerValidation } from "@armada/core/read";
import Image from "next/image";
import Link from "next/link";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { decideValidation } from "@/app/actions";
import { fileShape, paths } from "@/lib/fleet-view";
import type { Strings } from "@/lib/i18n";
import { type ActionContext, ErrorLine, PendingNote, SignerField, signerOf, useRequest, useSent } from "../Actions";
import { Card, CardHead, CardMeta, CardTitle } from "../page";
import { Dot, ProjectChip, Tag } from "../ui";

const KIND_COLOR: Record<OwnerValidation["kind"], string> = {
  merge: "var(--done)",
  validation: "var(--accent)",
  question: "var(--frontier)",
};

const CI_COLOR: Record<CiState, string> = {
  success: "var(--done)",
  failure: "var(--critical)",
  pending: "var(--active)",
  none: "var(--text-3)",
};

/** How many screenshots the overview's card shows before "+n". */
const COMPACT_IMAGES = 3;
/** How many files the approval page lists before "+n". */
const FULL_FILES = 30;

interface Sent {
  body: string;
  author: string | null;
  at: string;
}

export function ValidationCard({
  ctx,
  v,
  projectName,
  mode = "list",
}: {
  ctx: ActionContext;
  v: OwnerValidation;
  projectName: string;
  /** `list`: the Validations page; `full`: the approval page. */
  mode?: "list" | "full";
}) {
  const { t, now } = ctx;
  const s = t.validations;
  const color = KIND_COLOR[v.kind];
  const title = v.title ?? v.what.split("\n")[0] ?? v.ticket;
  const ago = (iso: string) => t.ago(Math.max(0, now - Date.parse(iso)));
  const body = v.kind === "merge" ? null : v.what;
  return (
    <Card className={`vd-card is-${mode}`}>
      <CardHead
        icon={<Dot color={color} />}
        label={s.kinds[v.kind]}
        color={color}
        side={<span title={v.createdAt}>{ago(v.createdAt)}</span>}
      />
      <CardTitle>
        {mode === "full" ? (
          v.url ? (
            <a href={v.url} target="_blank" rel="noreferrer">
              {title}
            </a>
          ) : (
            title
          )
        ) : (
          <Link href={paths.validation(v.id)} prefetch>
            {title}
          </Link>
        )}
      </CardTitle>
      <CardMeta>
        <Tag>
          <ProjectChip slug={v.project} name={projectName} />
        </Tag>
        <Link href={paths.agent(v.ticket)} prefetch className="mono">
          {v.ticket}
        </Link>
        {v.author && <span>{s.askedBy(v.author, ago(v.createdAt))}</span>}
      </CardMeta>
      {body && (
        <p className="wait-detail is-quote" style={{ ["--q" as string]: color }}>
          {body}
        </p>
      )}
      {v.reason && (
        <p className="vd-reason">
          <span className="faint">{s.reason}</span> {v.reason}
        </p>
      )}
      {v.pr && <PullRequest t={t} pr={v.pr} full={mode === "full"} />}
      {v.pr?.preview && (
        <a className="ui-button vd-preview" href={v.pr.preview} target="_blank" rel="noreferrer">
          {s.preview}
          <span aria-hidden>↗</span>
        </a>
      )}
      {mode === "full" && v.decision === null ? (
        <LargeGallery t={t} items={v.gallery} />
      ) : (
        <Gallery t={t} items={v.gallery} compact={v.decision !== null} more={paths.validation(v.id)} />
      )}
      {v.decision ? (
        <p className="vd-decided">
          <Dot color={v.decision.outcome === "approved" ? "var(--done)" : "var(--text-3)"} size={6} />
          <b>{v.decision.answer ?? s.outcome[v.decision.outcome]}</b>{" "}
          <span className="faint">{s.by(v.decision.by, ago(v.decision.at))}</span>
          {v.decision.note && <span className="vd-note">{v.decision.note}</span>}
        </p>
      ) : (
        <Decide ctx={ctx} v={v} projectName={projectName} />
      )}
    </Card>
  );
}

function PullRequest({ t, pr, full }: { t: Strings; pr: NonNullable<OwnerValidation["pr"]>; full: boolean }) {
  const s = t.validations;
  const files = pr.files ?? [];
  const ci = pr.ci ?? "none";
  return (
    <div className="vd-pr">
      <a href={pr.url} target="_blank" rel="noreferrer" className="vd-pr-title">
        <span className="mono">{s.pr(pr.number)}</span> {pr.title}
      </a>
      <CardMeta>
        {pr.additions !== null && (
          <span className="sc-file-delta">
            <span className="sc-add">+{pr.additions}</span> <span className="sc-del">−{pr.deletions ?? 0}</span>
          </span>
        )}
        {pr.files && <span>{s.files(files.length)}</span>}
        <span className="vd-ci">
          <Dot color={CI_COLOR[ci]} size={6} />
          {s.ci[ci]}
        </span>
        <span className="mono" title={pr.headSha}>
          {pr.headSha.slice(0, 7)}
        </span>
      </CardMeta>
      {full && files.length > 0 && (
        <ul className="vd-files">
          {files.slice(0, FULL_FILES).map((f) => {
            const shape = fileShape(f);
            return (
              <li key={f.path}>
                <span className="sc-file-path">
                  <span className="faint">{shape.dir}</span>
                  {shape.name}
                </span>
                <span className="sc-file-delta">
                  <span className="sc-add">+{f.additions}</span> <span className="sc-del">−{f.deletions}</span>
                </span>
              </li>
            );
          })}
          {files.length > FULL_FILES && <li className="faint">{s.more(files.length - FULL_FILES)}</li>}
        </ul>
      )}
    </div>
  );
}

/** The screenshots, enlarged on a click, then the links; on the overview's card, the first few. */
function Gallery({ t, items, compact, more }: { t: Strings; items: Attachment[]; compact: boolean; more: string }) {
  const s = t.validations;
  const [chosen, setChosen] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const images = items.filter((a) => a.kind === "image");
  const links = items.filter((a) => a.kind === "link" && a.url);
  const selected = images.find((a) => a.id === chosen);
  useEffect(() => {
    const element = dialog.current;
    if (selected && element && !element.open) element.showModal();
    if (!selected && element?.open) element.close();
  }, [selected]);
  if (!images.length && !links.length) return compact ? null : <p className="calm">{s.noGallery}</p>;
  const shown = compact ? images.slice(0, COMPACT_IMAGES) : images;
  const hidden = images.length - shown.length;
  return (
    <div className="vd-gallery">
      {shown.length > 0 && (
        <ul className={`vd-shots${compact ? " is-compact" : ""}`}>
          {shown.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="vd-shot"
                onClick={() => setChosen(a.id)}
                aria-label={s.enlarge(a.caption ?? s.screenshot)}
              >
                <Image
                  src={`/api/attachments/${a.id}`}
                  alt={a.caption ?? s.screenshot}
                  width={compact ? 240 : 640}
                  height={compact ? 150 : 400}
                  unoptimized
                />
              </button>
              {!compact && a.caption && <span className="vd-caption">{a.caption}</span>}
            </li>
          ))}
          {hidden > 0 && (
            <li>
              <Link href={more} prefetch className="vd-shot vd-more">
                {s.more(hidden)}
              </Link>
            </li>
          )}
        </ul>
      )}
      {!compact &&
        links.map((a) => (
          <a key={a.id} href={a.url ?? undefined} target="_blank" rel="noreferrer" className="vd-link">
            {a.caption ?? a.url}
            <span aria-hidden>↗</span>
          </a>
        ))}
      <dialog
        ref={dialog}
        className="attachment-dialog"
        onCancel={() => setChosen(null)}
        onClose={() => setChosen(null)}
        aria-label={selected?.caption ?? s.screenshot}
      >
        <button type="button" className="ui-button" onClick={() => setChosen(null)}>
          {t.shell.agent.closeAttachment}
        </button>
        {selected && (
          <>
            <Image
              src={`/api/attachments/${selected.id}`}
              alt={selected.caption ?? s.screenshot}
              width={1280}
              height={800}
              unoptimized
            />
            {selected.caption && <p>{selected.caption}</p>}
          </>
        )}
      </dialog>
    </div>
  );
}

/**
 * What a session asks the owner to validate, large (THE-916): each image the
 * card's full width, its caption under it. A click opens it full screen: the
 * arrow keys move between the images, Esc or Close leaves, and the focus goes
 * back to the image it was opened from. Then the links.
 */
function LargeGallery({ t, items }: { t: Strings; items: Attachment[] }) {
  const s = t.validations;
  const images = items.filter((a) => a.kind === "image");
  const links = items.filter((a) => a.kind === "link" && a.url);
  const [open, setOpen] = useState<number | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const shots = useRef<(HTMLButtonElement | null)[]>([]);
  const from = useRef(0);
  useEffect(() => {
    const element = dialog.current;
    if (open !== null && element && !element.open) element.showModal();
    if (open === null && element?.open) element.close();
  }, [open]);
  if (!images.length && !links.length) return <p className="calm">{s.noGallery}</p>;
  const show = (k: number) => {
    from.current = k;
    setOpen(k);
  };
  const close = () => {
    setOpen(null);
    shots.current[from.current]?.focus();
  };
  const move = (step: number) => setOpen((k) => (k === null ? k : (k + step + images.length) % images.length));
  const current = open === null ? null : images[open];
  return (
    <div className="vd-gallery">
      {images.length > 0 && (
        <ul className="vd-large">
          {images.map((a, k) => (
            <li key={a.id}>
              <figure>
                <button
                  type="button"
                  className="vd-large-shot"
                  ref={(el) => {
                    shots.current[k] = el;
                  }}
                  onClick={() => show(k)}
                  aria-label={s.enlarge(a.caption ?? s.screenshot)}
                >
                  <Image
                    src={`/api/attachments/${a.id}`}
                    alt={a.caption ?? s.screenshot}
                    width={1600}
                    height={1000}
                    unoptimized
                  />
                </button>
                {a.caption && <figcaption className="vd-caption">{a.caption}</figcaption>}
              </figure>
            </li>
          ))}
        </ul>
      )}
      {links.map((a) => (
        <a key={a.id} href={a.url ?? undefined} target="_blank" rel="noreferrer" className="vd-link">
          {a.caption ?? a.url}
          <span aria-hidden>↗</span>
        </a>
      ))}
      <dialog
        ref={dialog}
        className="vd-viewer"
        aria-label={current?.caption ?? s.screenshot}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        onKeyDown={(e) => {
          if (images.length < 2 || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
          e.preventDefault();
          move(e.key === "ArrowRight" ? 1 : -1);
        }}
      >
        {current && open !== null && (
          <>
            <div className="vd-viewer-bar">
              <span className="vd-viewer-count" aria-live="polite">
                {s.viewer.position(open + 1, images.length)}
              </span>
              <span className="vd-viewer-caption">{current.caption}</span>
              <span className="spacer" />
              <span className="vd-viewer-hint">{images.length > 1 ? s.viewer.hint : null}</span>
              <button type="button" className="btn" onClick={close}>
                {t.shell.agent.closeAttachment}
              </button>
            </div>
            <div className="vd-viewer-stage">
              {images.length > 1 && (
                <button
                  type="button"
                  className="vd-viewer-nav is-prev"
                  onClick={() => move(-1)}
                  aria-label={s.viewer.previous}
                  title={s.viewer.previous}
                >
                  <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden>
                    <path
                      d="M10 3.5L5.5 8l4.5 4.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
              <Image
                key={current.id}
                src={`/api/attachments/${current.id}`}
                alt={current.caption ?? s.screenshot}
                width={1600}
                height={1000}
                unoptimized
              />
              {images.length > 1 && (
                <button
                  type="button"
                  className="vd-viewer-nav is-next"
                  onClick={() => move(1)}
                  aria-label={s.viewer.next}
                  title={s.viewer.next}
                >
                  <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden>
                    <path
                      d="M6 3.5L10.5 8 6 12.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}

/**
 * The owner's buttons: Approve (the merge) and Request changes with a short
 * text, or the choices the validation was sent with. Shown as sent at once;
 * back with the reason when refused.
 */
export function Decide({
  ctx,
  v,
  projectName,
  changes = true,
  children,
}: {
  ctx: ActionContext;
  v: OwnerValidation;
  projectName: string;
  /** Offer "Request changes" here; the overview's pane leaves it to the validation's page. */
  changes?: boolean;
  /** More buttons, after the decision's (the overview's pane: the validation's page). */
  children?: ReactNode;
}) {
  const { t, now } = ctx;
  const s = t.validations;
  const [changing, setChanging] = useState(false);
  const [draft, setDraft] = useState("");
  const [sent, markSent, unmark] = useSent<Sent>(ctx.version);
  const shown = useRef<Sent | null>(null);
  const req = useRequest(decideValidation, {
    start: (form) => {
      const action = form.get("action");
      const body =
        action === "approve"
          ? v.kind === "merge"
            ? s.approveMerge
            : s.approve
          : action === "choice"
            ? String(form.get("choice") ?? "")
            : String(form.get("note") ?? "").trim();
      shown.current = { body, author: signerOf(ctx.signer, form), at: new Date(now).toISOString() };
      markSent(shown.current);
      setChanging(false);
    },
    done: () => {
      if (shown.current) markSent(shown.current);
      setDraft("");
      ctx.refresh();
    },
    undo: () => unmark(),
  });
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
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    } else if (e.key === "Escape") setChanging(false);
  };
  if (changing)
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
          <button type="button" className="btn is-ghost" onClick={() => setChanging(false)}>
            {t.cancel}
          </button>
          <button type="submit" className="btn is-primary" disabled={req.busy || !draft.trim()}>
            {t.send}
          </button>
        </div>
      </form>
    );
  return (
    <form className="question" onSubmit={req.submit} aria-label={`${s.kinds[v.kind]} · ${projectName}`}>
      {hidden}
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
              >
                {c}
              </button>
            ))}
          </>
        ) : (
          <>
            <button type="submit" name="action" value="approve" className="btn is-primary" disabled={req.busy}>
              {v.kind === "merge" ? s.approveMerge : s.approve}
            </button>
            {changes && (
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
            )}
          </>
        )}
        {children}
      </div>
    </form>
  );
}
