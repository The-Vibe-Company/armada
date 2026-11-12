import { ITEM_PARAM } from "./resource-list";

// Only our public state is passed to native history. Copying Next's private
// fields would bypass its URL synchronization.
let ownedUrl: URL | null = null;
let baseSearch = "";

function detailState() {
  return { armadaResourceDetail: window.location.pathname, armadaResourceBaseSearch: baseSearch };
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
  window.history.replaceState(null, "", window.location.href);
}

export function replaceResourceUrl(url: URL): void {
  const owned = ownsResourceDetail();
  if (owned) baseSearch = window.history.state.armadaResourceBaseSearch ?? "";
  const key = resourceReturnFocus();
  window.history.replaceState(
    owned ? detailState() : key ? { armadaResourceReturnFocus: { path: window.location.pathname, key } } : null,
    "",
    url,
  );
  ownedUrl = owned ? new URL(url) : null;
}

export function pushResourceDetail(url: URL): void {
  baseSearch = window.location.search;
  window.history.pushState(detailState(), "", url);
  ownedUrl = new URL(url);
}

/** Seed after reload and carry non-selection state back to the existing list entry.
 * This applies equally to browser Back and explicit dismissal. Build admission
 * and recovery keys belong to the page, not to the transient detail selection.
 */
export function syncResourceHistory(initial = false): void {
  if (initial) ownedUrl = null;
  const url = new URL(window.location.href);
  if (ownedUrl?.pathname === url.pathname && !url.searchParams.has(ITEM_PARAM)) {
    const baseline = new URLSearchParams(baseSearch);
    // Three-way merge: carry detail edits, but never overwrite a newer edit
    // made on the list while this detail entry was in Forward history.
    const keys = new Set([...baseline.keys(), ...ownedUrl.searchParams.keys()]);
    for (const key of keys) {
      if (key === ITEM_PARAM) continue;
      const before = baseline.getAll(key);
      const current = url.searchParams.getAll(key);
      const after = ownedUrl.searchParams.getAll(key);
      if (JSON.stringify(before) === JSON.stringify(after) || JSON.stringify(current) !== JSON.stringify(before))
        continue;
      url.searchParams.delete(key);
      for (const value of after) url.searchParams.append(key, value);
    }
    const key = ownedUrl.searchParams.get(ITEM_PARAM);
    window.history.replaceState(key ? { armadaResourceReturnFocus: { path: url.pathname, key } } : null, "", url);
  }
  ownedUrl = ownsResourceDetail() ? new URL(window.location.href) : null;
  baseSearch = ownedUrl ? (window.history.state.armadaResourceBaseSearch ?? "") : "";
}
