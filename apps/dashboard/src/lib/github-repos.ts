import {
  type GitHubReposRequest,
  type GitHubReposResponse,
  githubReposRequest,
  githubReposResponse,
} from "@armada/core/contract";

export type GitHubReposFailureKind = "disconnected" | "revoked" | "unauthorized" | "unavailable" | "error";
export type GitHubReposLoadResult =
  | { ok: true; data: GitHubReposResponse }
  | { ok: false; kind: GitHubReposFailureKind; message: string };

const URL_RE = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)/i;
const SLUG_RE = /^[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9._-]{1,200}$/;
const cmp = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });
const fail = (kind: GitHubReposFailureKind, message: string) =>
  ({ ok: false, kind, message }) satisfies GitHubReposLoadResult;

export const repoKey = (v: string) => v.trim().toLowerCase();

export function buildGitHubReposRequest(org: string, query = "") {
  const q = query.trim();
  return { ...(org !== "all" ? { account: org } : {}), ...(q ? { query: q } : {}) } satisfies GitHubReposRequest;
}

export function parseManualRepoInput(input: string) {
  const s = input
    .trim()
    .replace(URL_RE, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const repo = s.split("/")[1];
  return SLUG_RE.test(s) && repo !== "." && repo !== ".." ? s : null;
}

export function buildGitHubRepoPickerView(
  data: GitHubReposResponse | null,
  choices: readonly (readonly [string, number])[],
  selectedOrg: string,
  query: string,
  loadedOrg = "all",
  loadedQuery = "",
) {
  const repos = data?.repositories ?? [];
  const orgs = new Map<string, { login: string; count: number }>();
  for (const i of data?.installations ?? []) orgs.set(repoKey(i.accountLogin), { login: i.accountLogin, count: 0 });
  const live = new Set<string>();
  for (const r of repos) {
    live.add(repoKey(r.fullName));
    const k = repoKey(r.accountLogin);
    const cur = orgs.get(k);
    orgs.set(k, { login: cur?.login ?? r.accountLogin, count: (cur?.count ?? 0) + 1 });
  }
  const activeOrg = selectedOrg === "all" || orgs.has(repoKey(selectedOrg)) ? selectedOrg : "all";
  const acct = activeOrg !== "all" ? repoKey(activeOrg) : "";
  const needle = repoKey(query);
  const ready = new Map(choices.map(([s, n]) => [repoKey(s), n]));
  type Item = { id: string; fullName: string; isPrivate?: boolean; archived?: boolean; readyCount?: number };
  const gMap = new Map<string, { key: string; heading: string; items: Item[] }>();
  const shown = new Set<string>();
  for (const r of repos) {
    if (acct && repoKey(r.accountLogin) !== acct && repoKey(r.owner) !== acct) continue;
    const low = r.fullName.toLowerCase();
    if (needle && !low.includes(needle) && !r.accountLogin.toLowerCase().includes(needle)) continue;
    const rk = repoKey(r.fullName);
    shown.add(rk);
    const gk = repoKey(r.accountLogin);
    const heading = `${r.accountLogin} · ${r.accountType === "Organization" ? "Org" : "Personal"}`;
    const g = gMap.get(gk) ?? { key: r.accountLogin, heading, items: [] };
    const rc = ready.get(rk);
    const item: Item = { id: `r:${r.id}`, fullName: r.fullName, isPrivate: r.private, archived: r.archived };
    if (rc) item.readyCount = rc;
    g.items.push(item);
    gMap.set(gk, g);
  }
  const groups = [...gMap.values()]
    .sort((a, b) => cmp(a.key, b.key))
    .map((g) => ({ ...g, items: g.items.sort((a, b) => cmp(a.fullName, b.fullName)) }));
  const extra: Item[] = choices.flatMap(([slug, readyCount]) => {
    const k = repoKey(slug);
    if (live.has(k) || (acct && k.split("/")[0] !== acct) || (needle && !k.includes(needle))) return [];
    shown.add(k);
    return [{ id: `s:${slug}`, fullName: slug, ...(readyCount > 0 ? { readyCount } : {}) }];
  });
  if (extra.length) groups.push({ key: "snapshots", heading: "Ready in snapshots", items: extra });
  const manualRepo = parseManualRepoInput(query);
  const showManual = manualRepo !== null && !shown.has(repoKey(manualRepo));
  const okCount = !loadedQuery && !data?.truncated;
  const all = loadedOrg === "all";
  const countOf = (login: string, n: number) =>
    okCount && (all || repoKey(loadedOrg) === repoKey(login)) ? n : undefined;
  const orgPills = [...orgs.values()]
    .sort((a, b) => cmp(a.login, b.login))
    .map((o) => ({ key: o.login, label: o.login, count: countOf(o.login, o.count) }));
  const pills = orgs.size
    ? [{ key: "all", label: "All orgs", count: okCount && all ? repos.length : undefined }, ...orgPills]
    : [];
  return { pills, activeOrg, groups, manualRepo, showManual, hasItems: groups.length > 0 || showManual };
}

export function selectedRepoKeys(values: readonly string[]) {
  const out = new Set<string>();
  for (const v of values) {
    const p = parseManualRepoInput(v);
    if (p) out.add(repoKey(p));
  }
  return out;
}

export function applyRepoSelectionToRows<T extends { url: string }>(
  rows: readonly T[],
  fullName: string,
  createRow: (url: string) => T,
  maxRepos: number,
) {
  const target = repoKey(fullName);
  const idx = rows.findIndex((r) => repoKey(parseManualRepoInput(r.url) ?? "") === target);
  if (idx !== -1)
    return rows.length === 1 ? rows.map((r, i) => (i === 0 ? { ...r, url: "" } : r)) : rows.filter((_, i) => i !== idx);
  const blank = rows.findIndex((r) => !r.url.trim());
  if (blank !== -1) return rows.map((r, i) => (i === blank ? { ...r, url: fullName } : r));
  return rows.length >= maxRepos ? [...rows] : [...rows, createRow(fullName)];
}

export function classifyGitHubReposFailure(status?: number, code?: string, message?: string) {
  if (status === 401 || code === "unauthorized")
    return fail("unauthorized", "Sign in again to browse GitHub repositories.");
  if (status === 403 || code === "forbidden")
    return /revoked|expired/i.test(message ?? "")
      ? fail("revoked", "GitHub connection expired or revoked. Reconnect in Settings or type owner/repo.")
      : fail("disconnected", "GitHub is not connected. Connect GitHub in Settings or type owner/repo.");
  if (status === 503 || code === "unavailable" || code === "dependency_unavailable")
    return fail("unavailable", "GitHub repositories are temporarily unavailable. Retry or type owner/repo.");
  return fail("error", "GitHub repositories could not be loaded. Retry or type owner/repo.");
}

export async function fetchGitHubReposWith(
  post: (route: string, body: Record<string, unknown>) => Promise<unknown>,
  input?: GitHubReposRequest,
) {
  const req = githubReposRequest.safeParse(input ?? {});
  if (!req.success) return fail("error", "That GitHub repository filter is not valid.");
  const res = githubReposResponse.safeParse(await post("github/repos", req.data));
  return res.success
    ? ({ ok: true, data: res.data } satisfies GitHubReposLoadResult)
    : fail("error", "GitHub repositories sent an unreadable response. Type owner/repo instead.");
}
