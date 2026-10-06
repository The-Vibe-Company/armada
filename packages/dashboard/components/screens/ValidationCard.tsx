"use client";

// One thing the owner validates (THE-885), as the Validations page shows it
// (THE-1021, design/dashboard-v7): its kind, ticket, project and who asked;
// what to check and why the owner; the pull request in one strip (number,
// head, diff, CI, preview); the screenshots, full screen on a click (the
// arrow keys between them, THE-916), then the links; a note for the
// coordinator and the owner's buttons, or the decision once taken. Each
// button is a request: the decision lands in the coordinator's inbox, which
// merges or relays it. The buttons are `Decide` (Decide.tsx), shared with
// the overview's pane and a session's page, without the note. On the
// Validations page they take the keys too (THE-1113, lib/validation-keys.ts):
// A, C and 1–6.
import type { Attachment, CiState, OwnerValidation } from "@armada/core/read";
import Image from "next/image";
import Link from "next/link";
import { type Ref, useEffect, useRef, useState } from "react";
import { paths } from "@/lib/fleet-view";
import type { Strings } from "@/lib/i18n";
import type { ActionContext } from "../Actions";
import { Decide, type DecideKeys, type Sent } from "./Decide";

/** A kind's color: a question is blue, a merge or work to check amber. */
export const VALIDATION_COLOR: Record<OwnerValidation["kind"], string> = {
  merge: "var(--amber)",
  validation: "var(--amber)",
  question: "var(--blue)",
  secret: "var(--blue)",
};

const CI_COLOR: Record<CiState, string> = {
  success: "var(--green)",
  failure: "var(--red)",
  pending: "var(--amber)",
  none: "var(--text-3)",
};

/** The words a validation is about: a merge's pull request title, else what to check. */
export const validationTitle = (v: OwnerValidation) =>
  (v.kind === "merge" ? v.title : null) ?? v.what.split("\n").find((l) => l.trim()) ?? v.ticket;

export function ValidationDetail({
  ctx,
  v,
  projectName,
  keys,
  onDone,
  sentBefore,
}: {
  ctx: ActionContext;
  v: OwnerValidation;
  projectName: string;
  /** The page's keys reach the buttons through this (the Validations page). */
  keys?: Ref<DecideKeys>;
  /** Once the decision is recorded: the page opens the next one. */
  onDone?: (sent: Sent) => void;
  /** Sent from this tab on an earlier visit, not in the overview yet: shown as sent. */
  sentBefore?: Sent | null;
}) {
  const { t, now } = ctx;
  const s = t.validations;
  const color = VALIDATION_COLOR[v.kind];
  const ago = (iso: string) => t.ago(Math.max(0, now - Date.parse(iso)));
  const title = validationTitle(v);
  const rest = v.what.trim() === title.trim() ? null : v.kind === "merge" ? v.what : v.what.slice(title.length).trim();
  return (
    <article className="vd-detail" aria-labelledby={`validation-${v.id}`}>
      <div className="vd-head">
        <p className="pg-meta">
          <span style={{ color }}>{s.kinds[v.kind]}</span>
          <span aria-hidden>·</span>
          <Link href={paths.agent(v.ticket)} prefetch={false} className="mono pg-link">
            {v.ticket}
          </Link>
          <span aria-hidden>·</span>
          <span>{projectName}</span>
          {v.author && (
            <>
              <span aria-hidden>·</span>
              <span>{s.askedBy(v.author, ago(v.createdAt))}</span>
            </>
          )}
        </p>
        <h2 className="vd-what" id={`validation-${v.id}`}>
          {v.url ? (
            <a href={v.url} target="_blank" rel="noreferrer">
              {title}
            </a>
          ) : (
            title
          )}
        </h2>
        {rest && <p className="vd-body">{rest}</p>}
        {v.reason && <p className="vd-why">{s.whyYou(v.reason)}</p>}
      </div>
      {!!v.checks?.length && (
        <ul className="vd-checks" aria-label={s.checks}>
          {v.checks.map((check) => (
            <li key={check}>{check}</li>
          ))}
        </ul>
      )}
      {!!v.excerpts?.length && (
        <div className="vd-excerpts">
          {v.excerpts.map((excerpt) => (
            <figure key={`${excerpt.label}-${excerpt.text}`}>
              <figcaption>{excerpt.label}</figcaption>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable excerpt takes the keyboard (axe: scrollable-region-focusable) */}
              <section className="vd-excerpt-text" tabIndex={0} aria-label={excerpt.label}>
                <pre>{excerpt.text}</pre>
              </section>
            </figure>
          ))}
        </div>
      )}
      {v.details && (
        <details className="vd-context">
          <summary>{s.details}</summary>
          <p className="vd-body">{v.details}</p>
        </details>
      )}
      {v.pr && <PrFacts t={t} pr={v.pr} />}
      <Gallery t={t} items={v.gallery} />
      {!!v.galleryMore && <p className="vd-more">{s.more(v.galleryMore)}</p>}
      {v.decision ? (
        <div className="vd-outcome">
          <span
            className="vd-outcome-h"
            style={{ color: v.decision.outcome === "approved" ? "var(--green)" : undefined }}
          >
            {s.by(v.decision.answer ?? s.outcome[v.decision.outcome], v.decision.by)}
            <span className="vd-outcome-ago"> · {ago(v.decision.at)}</span>
          </span>
          {v.decision.note && <span className="vd-outcome-note">« {v.decision.note} »</span>}
        </div>
      ) : (
        <Decide ctx={ctx} v={v} projectName={projectName} note keys={keys} onDone={onDone} sentBefore={sentBefore} />
      )}
    </article>
  );
}

/** The pull request in one strip: its number, head, diff, CI and preview. */
function PrFacts({ t, pr }: { t: Strings; pr: NonNullable<OwnerValidation["pr"]> }) {
  const s = t.validations;
  const ci = pr.ci ?? "none";
  return (
    <dl className="vd-pr">
      <div>
        <dt>{s.facts.pr}</dt>
        <dd className="mono">
          <a href={pr.url} target="_blank" rel="noreferrer">
            #{pr.number}
          </a>
        </dd>
      </div>
      <div>
        <dt>{s.facts.head}</dt>
        <dd className="mono" title={pr.headSha}>
          {pr.headSha.slice(0, 7)}
        </dd>
      </div>
      {pr.additions !== null && (
        <div>
          <dt>{s.facts.diff}</dt>
          <dd className="mono">{s.diff(pr.additions, pr.deletions ?? 0, pr.files ? pr.files.length : null)}</dd>
        </div>
      )}
      <div>
        <dt>{s.facts.ci}</dt>
        <dd className="mono" style={{ color: CI_COLOR[ci] }}>
          {s.ci[ci]}
        </dd>
      </div>
      {pr.preview && (
        <div>
          <dt>{s.facts.preview}</dt>
          <dd className="mono">
            <a href={pr.preview} target="_blank" rel="noreferrer" className="vd-preview">
              {pr.preview.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            </a>
          </dd>
        </div>
      )}
    </dl>
  );
}

/**
 * The screenshots in a grid, each with its caption. A click opens one full
 * screen: the arrow keys move between them, Esc or Close leaves, and the
 * focus goes back to the image it was opened from. Then the links.
 */
function Gallery({ t, items }: { t: Strings; items: Attachment[] }) {
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
  if (!images.length && !links.length) return null;
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
        <ul className="vd-shots">
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
                    width={640}
                    height={480}
                    unoptimized
                  />
                </button>
                {a.caption && <figcaption>{a.caption}</figcaption>}
              </figure>
            </li>
          ))}
        </ul>
      )}
      {links.length > 0 && (
        <ul className="vd-links">
          {links.map((a) => (
            <li key={a.id}>
              <a href={a.url ?? undefined} target="_blank" rel="noreferrer">
                {a.caption ?? a.url} ↗
              </a>
            </li>
          ))}
        </ul>
      )}
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
              <button type="button" className="btn is-soft" onClick={close}>
                {s.viewer.close}
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
