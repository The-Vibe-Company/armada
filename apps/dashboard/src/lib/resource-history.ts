import { ITEM_PARAM } from "./resource-list";

// Only our public state is passed to native history. Copying Next's private
// fields would bypass its URL synchronization.
//
// The open detail's latest URL and the list search it started from live in
// the tab's sessionStorage, keyed by an id stamped on both the detail entry and
// the list entry beneath it. Module memory is not enough: after a reload,
// native Back can fire popstate before this document hydrates and subscribes,
// and the document that finally sees the list entry never saw the detail.
type OpenDetail = { id: string; url: string; base: string };
const STORAGE_KEY = "armada.resource-detail";
let memory: OpenDetail | null = null;
let sequence = 0;

function remember(detail: OpenDetail | null): void {
  memory = detail;
  try {
    if (detail) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(detail));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable; this document still has its memory copy.
  }
}

function recall(): OpenDetail | null {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null");
    if (stored && typeof stored.id === "string" && typeof stored.url === "string" && typeof stored.base === "string")
      return stored;
  } catch {
    // Fall back to this document's memory.
  }
  return memory;
}

function detailState(id: string | null, base: string) {
  return { armadaResourceDetail: window.location.pathname, armadaResourceBaseSearch: base, armadaResourceDetailId: id };
}

/** The list entry's state: the detail it lies beneath, and the row to refocus. */
function listState(base: unknown, key: string | null, path = window.location.pathname) {
  if (typeof base !== "string" && !key) return null;
  return {
    ...(typeof base === "string" ? { armadaResourceBase: base } : {}),
    ...(key ? { armadaResourceReturnFocus: { path, key } } : {}),
  };
}

export function ownsResourceDetail(): boolean {
  return window.history.state?.armadaResourceDetail === window.location.pathname;
}

/** Kept on the destination entry so a replacement list tree can restore focus too. */
export function resourceReturnFocus(): string | null {
  const target = window.history.state?.armadaResourceReturnFocus;
  return target?.path === window.location.pathname && typeof target.key === "string" ? target.key : null;
}

export function clearResourceReturnFocus(): void {
  if (!resourceReturnFocus()) return;
  window.history.replaceState(listState(window.history.state?.armadaResourceBase, null), "", window.location.href);
}

export function replaceResourceUrl(url: URL): void {
  const state = window.history.state;
  if (ownsResourceDetail()) {
    const base = state.armadaResourceBaseSearch ?? "";
    const id = typeof state.armadaResourceDetailId === "string" ? state.armadaResourceDetailId : null;
    window.history.replaceState(detailState(id, base), "", url);
    if (id) remember({ id, url: url.href, base });
    return;
  }
  window.history.replaceState(listState(state?.armadaResourceBase, resourceReturnFocus()), "", url);
}

export function pushResourceDetail(url: URL): void {
  const id = `${performance.timeOrigin}-${++sequence}`;
  const base = window.location.search;
  // Stamp the list entry first, so whichever document lands on it can match it.
  window.history.replaceState(listState(id, resourceReturnFocus()), "", window.location.href);
  window.history.pushState(detailState(id, base), "", url);
  remember({ id, url: url.href, base });
}

/** Seed after reload and carry non-selection state back to the existing list entry.
 * This applies equally to browser Back and explicit dismissal, and to a Back
 * that happened before this document subscribed. Build admission and recovery
 * keys belong to the page, not to the transient detail selection.
 */
export function syncResourceHistory(): void {
  const state = window.history.state;
  const url = new URL(window.location.href);
  if (ownsResourceDetail()) {
    // Forward, or a load, onto a detail entry makes it the open detail again.
    if (typeof state.armadaResourceDetailId === "string")
      remember({ id: state.armadaResourceDetailId, url: url.href, base: state.armadaResourceBaseSearch ?? "" });
    return;
  }
  const open = recall();
  if (!open || state?.armadaResourceBase !== open.id || url.searchParams.has(ITEM_PARAM)) return;
  const owned = new URL(open.url);
  if (owned.pathname !== url.pathname) return;
  const baseline = new URLSearchParams(open.base);
  // Three-way merge: carry detail edits, but never overwrite a newer edit
  // made on the list while this detail entry was in Forward history.
  const keys = new Set([...baseline.keys(), ...owned.searchParams.keys()]);
  for (const key of keys) {
    if (key === ITEM_PARAM) continue;
    const before = baseline.getAll(key);
    const current = url.searchParams.getAll(key);
    const after = owned.searchParams.getAll(key);
    if (JSON.stringify(before) === JSON.stringify(after) || JSON.stringify(current) !== JSON.stringify(before))
      continue;
    url.searchParams.delete(key);
    for (const value of after) url.searchParams.append(key, value);
  }
  window.history.replaceState(listState(open.id, owned.searchParams.get(ITEM_PARAM), url.pathname), "", url);
  remember(null);
}
