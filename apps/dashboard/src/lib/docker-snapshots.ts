import { isUuid } from "./action.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Display metadata only: never an image selector or a proof of restorable local bytes. */
export type DockerSnapshot = { id: string; name: string; builtOnVersion: string; createdAt: string };
export type DockerSnapshotsResult = { state: "ready"; snapshots: DockerSnapshot[] } | { state: "unavailable" };

/** Fail the whole list on malformed or mis-scoped data; never show a partial success as an empty catalog. */
export function parseDockerSnapshots(value: unknown, hostId: string): DockerSnapshot[] | null {
  if (!isRecord(value) || !Array.isArray(value.snapshots)) return null;
  const result: DockerSnapshot[] = [];
  const ids = new Set<string>();
  for (const row of value.snapshots) {
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      !isUuid(row.id) ||
      ids.has(row.id) ||
      row.hostId !== hostId ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      row.name.length > 80 ||
      /[\p{C}]/u.test(row.name) ||
      typeof row.officialImageVersion !== "string" ||
      row.officialImageVersion.length > 80 ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(row.officialImageVersion) ||
      typeof row.officialImage !== "string" ||
      !/^ghcr\.io\/the-vibe-company\/armada-sandbox@sha256:[a-f0-9]{64}$/.test(row.officialImage) ||
      typeof row.createdAt !== "string" ||
      !Number.isFinite(Date.parse(row.createdAt))
    )
      return null;
    ids.add(row.id);
    result.push({ id: row.id, name: row.name, builtOnVersion: row.officialImageVersion, createdAt: row.createdAt });
  }
  return result;
}
