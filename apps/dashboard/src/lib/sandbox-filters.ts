import { HARNESSES, type Harness, type SandboxStatus } from "@armada/core";

export const SANDBOX_STATUSES: readonly SandboxStatus[] = [
  "starting",
  "ready",
  "running",
  "stopping",
  "stopped",
  "failed",
  "deleted",
];

export const PAGE_SIZE = 25;

export type SandboxFilters = {
  status: SandboxStatus | null;
  harness: Harness | null;
  /** `me` or a user id. */
  owner: string | null;
  page: number;
};

type Params = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string | null {
  const one = Array.isArray(value) ? value[0] : value;
  return one && one.length > 0 ? one : null;
}

/** Reads the filters off the URL. Anything that is not a known value is ignored, never passed to the database. */
export function parseSandboxFilters(params: Params): SandboxFilters {
  const status = first(params.status);
  const harness = first(params.harness);
  const owner = first(params.owner);
  const page = Number.parseInt(first(params.page) ?? "1", 10);
  return {
    status: SANDBOX_STATUSES.find((candidate) => candidate === status) ?? null,
    harness: HARNESSES.find((candidate) => candidate === harness) ?? null,
    owner: owner === "me" || (owner && UUID.test(owner)) ? owner : null,
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

export function filtersToSearch(filters: Partial<SandboxFilters>): string {
  const search = new URLSearchParams();
  if (filters.status) search.set("status", filters.status);
  if (filters.harness) search.set("harness", filters.harness);
  if (filters.owner) search.set("owner", filters.owner);
  if (filters.page && filters.page > 1) search.set("page", String(filters.page));
  const text = search.toString();
  return text ? `?${text}` : "";
}
