// The Validations page's keyboard (THE-1113): what a key does to the open
// validation, which one opens after a decision, and about how long those
// waiting take. Pure: the screen reads the event and the item, these decide.
import { type OwnerValidation, quantile } from "@armada/core/read";

/** What a key does to the open validation. */
export type KeyAction =
  | { kind: "approve" }
  /** Request changes: the note takes the focus, for the words. */
  | { kind: "changes" }
  /** ⌘↵ in the note after C: send the changes. */
  | { kind: "send" }
  /** Esc in the note: leave it, so the keys work again. */
  | { kind: "leave" }
  | { kind: "choice"; index: number };

export interface KeyPress {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  /** A key held down repeats: only the first decides. */
  repeat: boolean;
  /** Where it was typed: the page, the validation's note, or another field (which owns its keys). */
  where: "page" | "note" | "field";
}

export interface DecideState {
  /** Undecided, live, nothing sent and no request under way. */
  open: boolean;
  /** How many choices the validation was sent with; 0 for Approve and Request changes. */
  choices: number;
  /** C was pressed: ⌘↵ in the note sends the changes. */
  changing: boolean;
}

/** The choices a digit picks: 1 to 6. */
export const CHOICE_KEYS = 6;

/**
 * A, C and 1–6 on the page; in the note only ⌘↵ (after C) and Esc; nothing
 * in any other field, with a modifier on the page, or on a repeat.
 */
export function validationKey(press: KeyPress, state: DecideState): KeyAction | null {
  if (!state.open || press.repeat || press.where === "field") return null;
  if (press.where === "note") {
    if (press.key === "Escape") return { kind: "leave" };
    if (press.key === "Enter" && (press.meta || press.ctrl) && state.changing && !state.choices)
      return { kind: "send" };
    return null;
  }
  if (press.meta || press.ctrl || press.alt) return null;
  const key = press.key.toLowerCase();
  if (state.choices) {
    const index = Number(key) - 1;
    return /^[1-6]$/.test(key) && index < Math.min(state.choices, CHOICE_KEYS) ? { kind: "choice", index } : null;
  }
  if (key === "a") return { kind: "approve" };
  if (key === "c") return { kind: "changes" };
  return null;
}

/**
 * The waiting validation to open once `current` is decided: the one after it
 * (oldest first), else the first left; null when nothing waits. `sent` are
 * those decided here whose decision the overview does not show yet.
 */
export function nextOpen(
  pending: readonly Pick<OwnerValidation, "id">[],
  current: number,
  sent: { has: (id: number) => boolean },
): number | null {
  const left = pending.filter((v) => v.id !== current && !sent.has(v.id));
  const at = pending.findIndex((v) => v.id === current);
  const after = at < 0 ? undefined : pending.slice(at + 1).find((v) => left.includes(v));
  return (after ?? left[0])?.id ?? null;
}

/** Below this many decisions the median says nothing: no estimate. */
export const ESTIMATE_SAMPLES = 3;
/** Two decisions this close, by the same person, are one sitting: the second took the gap. */
export const SITTING_MS = 10 * 60_000;

/**
 * The owner's median time to decide one, in ms, over the decisions the
 * overview carries (the last week's): the gap between two decisions by the
 * same person at most ten minutes apart, the second one already waiting at
 * the first (else the gap counts its wait). Replaced ones are left out.
 * Null below three gaps. Not the Insights' owner wait, which counts from
 * when it was sent: hours, while the owner was away (THE-1113).
 */
export function decisionMedian(validations: readonly OwnerValidation[]): number | null {
  const byPerson = new Map<string, { at: number; sent: number }[]>();
  for (const v of validations) {
    if (!v.decision || v.decision.outcome === "superseded") continue;
    const who = v.decision.by ?? "";
    byPerson.set(who, [...(byPerson.get(who) ?? []), { at: Date.parse(v.decision.at), sent: Date.parse(v.createdAt) }]);
  }
  const gaps: number[] = [];
  for (const list of byPerson.values()) {
    list.sort((a, b) => a.at - b.at);
    list.forEach((d, k) => {
      const before = list[k - 1];
      const gap = before ? d.at - before.at : 0;
      if (before && gap > 0 && gap <= SITTING_MS && d.sent <= before.at) gaps.push(gap);
    });
  }
  return gaps.length < ESTIMATE_SAMPLES ? null : quantile(gaps, 0.5);
}

/** A key event as `validationKey` reads it. */
export const pressOf = (
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; repeat: boolean },
  where: KeyPress["where"],
): KeyPress => ({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, repeat: e.repeat, where });
