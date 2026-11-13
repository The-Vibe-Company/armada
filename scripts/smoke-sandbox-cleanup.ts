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
  now?: () => number;
  deadline?: number;
  sleep?: (ms: number) => Promise<void>;
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
]);
const RETRY_CODES = new Set([
  "conflict",
  "sandbox_not_ready",
  "provider_unavailable",
  "dependency_unavailable",
  "outcome_unknown",
]);
const CLEANUP_MS = 300_000; // Share the existing five-minute reserve across both deletion waves.

export async function deleteSmokeReceipts(
  origin: string,
  token: string,
  rows: SmokeSandboxReceipt[],
  io: CleanupIo,
  limit = 32,
): Promise<SmokeSandboxReceipt[]> {
  if (origin !== STAGING_ORIGIN) throw new Error("staging_only");
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms: number) => Bun.sleep(ms));
  const ordered = rows.toSorted(
    (a, b) => Number(a.requestKey.startsWith("smoke-scoped-")) - Number(b.requestKey.startsWith("smoke-scoped-")),
  );
  const selected = ordered.slice(0, limit);
  const remaining = ordered.slice(limit);
  // Deleted ordinary parents are the durable authority fence required before
  // their delegated children may be removed. Do not race the two admissions.
  const deadline = Math.min(now() + CLEANUP_MS, io.deadline ?? Number.POSITIVE_INFINITY);
  const cleanup = async (row: SmokeSandboxReceipt) => {
    let phase = "stop";
    let httpStatus: number | null = null;
    let code = "request_failed";
    async function request(action: "stop" | "status" | "delete") {
      const budget = deadline - now();
      if (budget <= 0) {
        if (httpStatus === null) code = "cleanup_timeout";
        throw Error("cleanup_timeout");
      }
      phase = action;
      code = "request_failed";
      httpStatus = null;
      const response = await io.fetch(
        action === "delete"
          ? `${origin}/api/v1/sandboxes/${encodeURIComponent(row.id)}?${new URLSearchParams({ org: row.org })}`
          : `${origin}/api/v1/sandbox/${action}`,
        {
          method: action === "delete" ? "DELETE" : "POST",
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(120_000, budget)),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(action === "delete" ? {} : { body: JSON.stringify({ org: row.org, id: row.id }) }),
        },
      );
      httpStatus = response.status;
      const body = (await response.json().catch(() => null)) as {
        id?: unknown;
        status?: unknown;
        error?: { code?: unknown };
      } | null;
      code = response.ok
        ? "invalid_receipt"
        : typeof body?.error?.code === "string" && ERROR_CODES.has(body.error.code)
          ? body.error.code
          : "api_failed";
      return { ok: response.ok, body };
    }
    async function pause() {
      if (now() >= deadline) throw Error("cleanup_timeout");
      await sleep(Math.min(5_000, deadline - now()));
    }
    try {
      // Dispatch stop once. An unknown acknowledgement is reconciled by read,
      // never by blindly replaying stop hooks on an archiving machine.
      let terminalStop = false;
      let alreadyDeleted = false;
      try {
        const stopped = await request("stop");
        if (!stopped.ok && !RETRY_CODES.has(code)) throw Error(code);
        if (stopped.ok && stopped.body?.id === row.id) {
          terminalStop = stopped.body.status === "stopped" || stopped.body.status === "failed";
          alreadyDeleted = stopped.body.status === "deleted";
        }
      } catch (error) {
        if (code !== "request_failed" && !RETRY_CODES.has(code)) throw error;
      }
      while (!terminalStop && !alreadyDeleted) {
        const status = await request("status");
        if (!status.ok) throw Error(code);
        if (status.body?.status === "deleted") {
          if (status.body.id !== row.id) throw Error(code);
          alreadyDeleted = true;
          break;
        }
        if (status.body?.status === "stopped" || status.body?.status === "failed") break;
        if (!["starting", "ready", "running", "stopping"].includes(String(status.body?.status))) throw Error(code);
        code = "stop_not_terminal";
        await pause();
      }
      if (!alreadyDeleted)
        while (true) {
          const deleted = await request("delete");
          if (deleted.ok && deleted.body?.id === row.id && deleted.body.status === "deleted") break;
          if (!RETRY_CODES.has(code)) throw Error(code);
          // A pending delete retains a two-minute activity lease. Do not refresh
          // provider status or replay stop; reconcile this same idempotent delete.
          io.out(JSON.stringify({ step: "delete_smoke_sandbox_retry", ...row, phase, httpStatus, code }));
          await pause();
        }
      io.out(JSON.stringify({ step: "delete_smoke_sandbox", pass: true, ...row }));
    } catch {
      remaining.push(row);
      io.out(JSON.stringify({ step: "delete_smoke_sandbox", pass: false, ...row, phase, httpStatus, code }));
    }
  };
  await Promise.all(selected.filter((row) => !row.requestKey.startsWith("smoke-scoped-")).map(cleanup));
  await Promise.all(selected.filter((row) => row.requestKey.startsWith("smoke-scoped-")).map(cleanup));
  return remaining;
}
