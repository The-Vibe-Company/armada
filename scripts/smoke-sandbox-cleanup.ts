import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const STAGING_ORIGIN = "https://armada-mcp-staging.up.railway.app";
export interface SmokeSandboxReceipt {
  requestKey: string;
  org: string;
  id: string;
  provider?: "boat" | "modal" | "docker";
}
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** Only explicit smoke receipts, never a fleet/status/golden heuristic. */
export function smokeReceipts(value: unknown): SmokeSandboxReceipt[] {
  if (!Array.isArray(value) || value.length > 4096) throw new Error("invalid_smoke_receipts");
  return value.map((row) => {
    if (
      !row ||
      !UUID.test(row.id) ||
      typeof row.org !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(row.org) ||
      typeof row.requestKey !== "string" ||
      !/^(?:post-deploy-smoke:|smoke-scoped-)[a-f0-9-]{36}$/.test(row.requestKey)
    )
      throw new Error("invalid_smoke_receipts");
    if (row.provider !== undefined && !["boat", "modal", "docker"].includes(row.provider))
      throw new Error("invalid_smoke_receipts");
    return {
      id: row.id,
      org: row.org,
      requestKey: row.requestKey,
      ...(row.provider ? { provider: row.provider } : {}),
    };
  });
}

export async function readSmokeJournal(path: string): Promise<SmokeSandboxReceipt[]> {
  try {
    return smokeReceipts(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
let journalWrite = Promise.resolve();
export function saveSmokeJournal(path: string, rows: SmokeSandboxReceipt[]) {
  journalWrite = journalWrite
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify(rows), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
  return journalWrite;
}

interface CleanupIo {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  out: (line: string) => void;
}
const ERROR_CODES = new Set([
  "invalid",
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "sandbox_not_ready",
  "provider_unavailable",
  "dependency_unavailable",
  "outcome_unknown",
  "credential_refused",
  "provider_not_configured",
  "unavailable",
  "internal",
  "unknown_route",
  "rate_limited",
  "payment_required",
  "unsupported",
  "sandbox_busy",
]);
export async function deleteSmokeReceipts(
  origin: string,
  token: string,
  rows: SmokeSandboxReceipt[],
  io: CleanupIo,
  { limit = 32, stopFirst = false } = {},
): Promise<SmokeSandboxReceipt[]> {
  if (origin !== STAGING_ORIGIN) throw new Error("staging_only");
  const scoped = (row: SmokeSandboxReceipt) => row.requestKey.startsWith("smoke-scoped-");
  const unique = new Map(rows.map((row) => [`${row.org}/${row.id}`, row]));
  const ordered = [...unique.values()].sort((a, b) => Number(scoped(a)) - Number(scoped(b)));
  const selected = ordered.slice(0, limit);

  async function requestStop(row: SmokeSandboxReceipt) {
    await io.fetch(`${origin}/api/v1/sandbox/stop`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ org: row.org, id: row.id }),
    });
  }

  async function requestDelete(row: SmokeSandboxReceipt) {
    let httpStatus: number | null = null;
    let code = "request_failed";
    try {
      const response = await io.fetch(
        `${origin}/api/v1/sandboxes/${encodeURIComponent(row.id)}?${new URLSearchParams({ org: row.org })}`,
        {
          method: "DELETE",
          redirect: "error",
          signal: AbortSignal.timeout(120_000),
          headers: { authorization: `Bearer ${token}` },
        },
      );
      httpStatus = response.status;
      const body = (await response.json().catch(() => null)) as {
        id?: unknown;
        status?: unknown;
        error?: { code?: unknown };
      } | null;
      if (
        (response.ok && body?.id === row.id && body.status === "deleted") ||
        (httpStatus === 404 && body?.error?.code === "not_found")
      ) {
        io.out(JSON.stringify({ step: "delete_smoke_sandbox", pass: true, ...row }));
        return true;
      }
      code = response.ok
        ? "invalid_receipt"
        : typeof body?.error?.code === "string" && ERROR_CODES.has(body.error.code)
          ? body.error.code
          : "api_failed";
    } catch {
      // The acknowledgement may have been lost. Keep the receipt for the next run.
    }
    io.out(JSON.stringify({ step: "delete_smoke_sandbox", pass: false, ...row, phase: "delete", httpStatus, code }));
    return false;
  }

  async function submit(batch: SmokeSandboxReceipt[]) {
    const results = await Promise.all(
      batch.map(async (row) => {
        if (stopFirst) await requestStop(row).catch(() => {});
        return requestDelete(row);
      }),
    );
    return batch.filter((_, index) => !results[index]);
  }

  // The server requires an ordinary parent to be durably deleted before its child.
  const ordinary = await submit(selected.filter((row) => !scoped(row)));
  const delegated = await submit(selected.filter(scoped));
  return [...ordinary, ...delegated, ...ordered.slice(limit)];
}
