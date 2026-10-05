// Pure plans: the CLI displays them before the one Linear writer applies them.
import type { SpecTitleStyle } from "./config.ts";
import { compareSpecs, type Spec } from "./model.ts";

export interface SpecPlan {
  create: { title: string; description: string } | null;
  renames: { uuid: string; from: string; to: string }[];
}

export const SPEC_DESCRIPTION = `## In short

* **What changes:** Describe the outcome for the owner.
* **Why:** Explain the problem this solves.
* **Done when:** List the observable acceptance checks.
* **Depends on:** Name prerequisite specs, or none.

---

## Technical detail

Describe the scope, constraints and implementation notes.
`;

function ordered(specs: readonly Spec[]): Spec[] {
  if (specs.some((s) => !Number.isSafeInteger(s.ordinal) || s.ordinal < 0))
    throw new Error("spec ordinals must be safe non-negative integers; fix the invalid titles first");
  return [...specs].sort(compareSpecs);
}

const title = (ordinal: number, total: number, name: string, style: SpecTitleStyle) =>
  `Spec ${ordinal}${style === "N/M" ? `/${total}` : ""} — ${name}`;

/** Null/undefined position appends after the largest ordinal; an insertion moves the suffix first. */
export function planSpecInsert(
  specs: readonly Spec[],
  name: string,
  at: number | null | undefined,
  style: SpecTitleStyle,
): SpecPlan {
  name = name.trim();
  if (!name || /[\r\n]/.test(name)) throw new Error("the spec name must be non-empty and on one line");
  const sorted = ordered(specs);
  const end = (sorted.at(-1)?.ordinal ?? 0) + 1;
  if (!Number.isSafeInteger(end)) throw new Error("the next spec ordinal is too large; run armada spec renumber first");
  const position = at ?? end;
  if (!Number.isSafeInteger(position) || position < 1 || position > end)
    throw new Error(`--at must be an integer between 1 and ${end}`);
  const total = sorted.length + 1;
  const renames = [...sorted].reverse().flatMap((spec) => {
    const ordinal = spec.ordinal >= position ? spec.ordinal + 1 : spec.ordinal;
    // N insertion preserves legacy denominators: changing totals is explicit opt-in.
    const to =
      style === "N/M"
        ? title(ordinal, total, spec.name, style)
        : ordinal === spec.ordinal
          ? spec.issue.title
          : spec.issue.title.replace(/^(\s*Spec\s+)\d+/, `$1${ordinal}`);
    return to === spec.issue.title ? [] : [{ uuid: spec.issue.uuid, from: spec.issue.title, to }];
  });
  return { create: { title: title(position, total, name, style), description: SPEC_DESCRIPTION }, renames };
}

/** Compact stable ordinal order to 1..count, normalizing titles to the configured style. */
export function planRenumber(specs: readonly Spec[], style: SpecTitleStyle): SpecPlan {
  const sorted = ordered(specs);
  return {
    create: null,
    renames: sorted.flatMap((spec, index) => {
      const to = title(index + 1, sorted.length, spec.name, style);
      return to === spec.issue.title ? [] : [{ uuid: spec.issue.uuid, from: spec.issue.title, to }];
    }),
  };
}
