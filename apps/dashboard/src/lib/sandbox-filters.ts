import { HARNESSES, MACHINE_SIZES, SANDBOX_PROVIDERS, type SandboxListMetadata } from "@armada/core";

export const SANDBOX_STATUSES = ["starting", "ready", "running", "stopping", "stopped", "failed", "deleted"] as const;
export const PAGE_SIZE = 25;
export const FACETS = ["status", "provider", "harness", "model", "owner", "size"] as const;
export type Facet = (typeof FACETS)[number];
export type SandboxFilters = Record<Facet, string[]> & {
  q: string;
  sort: "attention" | "newest" | "oldest" | "name";
  page: number;
};
type Params = Record<string, string | string[] | undefined>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const values = (value: string | string[] | undefined) => [
  ...new Set((Array.isArray(value) ? value : value ? [value] : []).filter(Boolean)),
];
const one = (value: string | string[] | undefined) => values(value)[0] ?? "";

/** Repeated parameters represent OR within a facet; distinct facets are ANDed. Unknown values fail closed. */
export function parseSandboxFilters(params: Params): SandboxFilters {
  const known = (key: string, choices: readonly string[]) =>
    values(params[key]).filter((value) => choices.includes(value));
  const page = Number(one(params.page));
  const sort = one(params.sort);
  return {
    status: known("status", SANDBOX_STATUSES),
    provider: known("provider", SANDBOX_PROVIDERS),
    harness: known("harness", HARNESSES),
    model: values(params.model).filter((value) => value.length <= 160),
    owner: values(params.owner).filter((value) => value === "me" || UUID.test(value)),
    size: known("size", [...MACHINE_SIZES, "unknown"]),
    q: one(params.q).trim().slice(0, 200),
    sort: sort === "newest" || sort === "oldest" || sort === "name" ? sort : "attention",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}
export function filtersToSearch(filters: Partial<SandboxFilters>): string {
  const search = new URLSearchParams();
  if (filters.q) search.set("q", filters.q);
  for (const key of FACETS) for (const value of filters[key] ?? []) search.append(key, value);
  if (filters.sort && filters.sort !== "attention") search.set("sort", filters.sort);
  if (filters.page && filters.page > 1) search.set("page", String(filters.page));
  return search.size ? `?${search}` : "";
}
export function hasSandboxFilters(filters: SandboxFilters): boolean {
  return Boolean(filters.q || FACETS.some((key) => filters[key].length));
}
export function facetValue(row: SandboxListMetadata, key: Facet): string {
  return key === "owner" ? row.ownerId : key === "size" ? (row.machineSize ?? "unknown") : (row[key] ?? "unknown");
}
/** Runs over the full authorized metadata inventory, never only the visible page. */
export function filterSandboxes(
  rows: readonly SandboxListMetadata[],
  filters: SandboxFilters,
  viewerId: string,
  except?: Facet,
): SandboxListMetadata[] {
  const q = filters.q.toLocaleLowerCase();
  return rows.filter((row) => {
    if (except !== "status" && !filters.status.length && row.status === "deleted") return false;
    if (q && ![row.id, row.displayLabel, row.providerSandboxId].some((value) => value?.toLocaleLowerCase().includes(q)))
      return false;
    return FACETS.every(
      (key) =>
        key === except ||
        !filters[key].length ||
        filters[key].some((value) => (key === "owner" && value === "me" ? viewerId : value) === facetValue(row, key)),
    );
  });
}
export function sortSandboxes(
  rows: readonly SandboxListMetadata[],
  sort: SandboxFilters["sort"],
): SandboxListMetadata[] {
  const priority = { failed: 0, ready: 1, stopped: 2, running: 3, starting: 4, stopping: 5, deleted: 6 };
  return [...rows].sort((a, b) => {
    const age = b.createdAt.localeCompare(a.createdAt);
    const attention = (row: SandboxListMetadata) => {
      if (
        row.status === "failed" ||
        ((row.status === "ready" || row.status === "stopped") && row.taskOutcome?.state === "blocked")
      )
        return 0;
      if ((row.status === "ready" || row.status === "stopped") && row.taskOutcome?.state === "ready") return 1;
      return priority[row.status] + 2;
    };
    const order =
      sort === "attention"
        ? attention(a) - attention(b) || age
        : sort === "oldest"
          ? -age
          : sort === "name"
            ? (a.providerSandboxId ?? a.displayLabel).localeCompare(b.providerSandboxId ?? b.displayLabel)
            : age;
    return order || a.id.localeCompare(b.id);
  });
}
export type FacetOption = { value: string; label: string; count: number };
export function sandboxFacetCounts(
  rows: readonly SandboxListMetadata[],
  filters: SandboxFilters,
  viewerId: string,
): Record<Facet, Map<string, number>> {
  return Object.fromEntries(
    FACETS.map((key) => {
      const counts = new Map<string, number>(rows.map((row) => [facetValue(row, key), 0]));
      for (const row of filterSandboxes(rows, filters, viewerId, key)) {
        const value = facetValue(row, key);
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return [key, counts];
    }),
  ) as Record<Facet, Map<string, number>>;
}
