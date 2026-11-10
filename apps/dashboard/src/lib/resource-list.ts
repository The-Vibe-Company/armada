import type { Tone } from "./status-tone.ts";

/**
 * The Build pages (#808) list every item of a kind in one list, ordered by what the viewer has to do: an item that
 * needs their action comes first, then what is ready, then the rest (disabled, waiting on someone else, not added).
 */
export type Bucket = "action" | "ready" | "rest";

const BUCKET_ORDER: Record<Bucket, number> = { action: 0, ready: 1, rest: 2 };

/** An item's state in plain words: the tone it is drawn in, a short label, and where it sorts. */
export type ResourceState = { bucket: Bucket; tone: Tone; label: string };

/** Needs action first, then ready, then the rest; by name inside each group, then by `tie` (a provider, an id). */
export function sortResources<T extends { bucket: Bucket; name: string; tie?: string }>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] ||
      a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }) ||
      (a.tie ?? "").localeCompare(b.tie ?? ""),
  );
}

/** A list this long offers a filter; a shorter one is read at a glance. */
export const FILTER_FROM = 8;

/** Whether an item's searchable text holds every word of the query, in any case and order. An empty query keeps all. */
export function matchesQuery(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/**
 * One thing that keeps the viewer from launching, as the strip on top of a Build page names it: a short imperative
 * label ("Connect Modal") and where it is fixed, either a page or a row of this list (its panel holds the fix).
 */
export type Blocker = {
  key: string;
  label: string;
  /** Why, in one short sentence: read aloud and shown on hover. */
  detail: string;
  target: { href: string } | { item: string };
};

/** The URL parameter that names the selected row, so a reload or a shared link reopens its panel. */
export const ITEM_PARAM = "item";
