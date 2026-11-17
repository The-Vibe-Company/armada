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
  "sandbox_busy",
]);
const RETRY_CODES = new Set([
  "unavailable",
  "sandbox_busy",
  "conflict",
  "sandbox_not_ready",
  "provider_unavailable",
  "dependency_unavailable",
  "outcome_unknown",
]);
const CLEANUP_WAVE_MS = 600_000; // Match parity lifecycle observation; provider deletion retains activity leases.
export const SMOKE_CLEANUP_BUDGET_MS = 2 * CLEANUP_WAVE_MS;

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
  const startedAt = now();
  let parentFinishedAt: number | undefined;
  const cleanup = async (row: SmokeSandboxReceipt, scoped = false, onStopped?: () => void) => {
    // Keep the original scoped observation window even when stop starts early.
    const deadline = () =>
      Math.min(
        (scoped ? (parentFinishedAt ?? startedAt + CLEANUP_WAVE_MS) : startedAt) + CLEANUP_WAVE_MS,
        io.deadline ?? Number.POSITIVE_INFINITY,
      );
    let phase = "stop";
    let httpStatus: number | null = null;
    let code = "request_failed";
    async function request(action: "stop" | "status" | "delete") {
      const budget = deadline() - now();
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
      const remainingMs = deadline() - now();
      if (remainingMs <= 0) throw Error("cleanup_timeout");
      await sleep(Math.min(5_000, remainingMs));
    }
    try {
      // Observe admitted/unknown stops without replaying hooks on archiving compute.
      // A busy refusal may be retried after a ready observation; the endpoint fences admitted stops.
      let terminalStop = false;
      let alreadyDeleted = false;
      let retryStopAdmission = false;
      async function dispatchStop() {
        try {
          const stopped = await request("stop");
          if (!stopped.ok && httpStatus === 404 && code === "not_found") {
            alreadyDeleted = true;
            return;
          }
          if (!stopped.ok && !RETRY_CODES.has(code)) throw Error(code);
          // Only an explicit busy response permits retry. Lost acknowledgement is read-only reconciliation.
          retryStopAdmission =
            !stopped.ok && httpStatus === 409 && ["conflict", "sandbox_not_ready", "sandbox_busy"].includes(code);
          if (stopped.ok && stopped.body?.id === row.id) {
            terminalStop = stopped.body.status === "stopped" || stopped.body.status === "failed";
            alreadyDeleted = stopped.body.status === "deleted";
          }
        } catch (error) {
          if (code !== "request_failed" && !RETRY_CODES.has(code)) throw error;
          retryStopAdmission = false;
        }
      }
      async function stopAndObserve() {
        terminalStop = false;
        await dispatchStop();
        while (!terminalStop && !alreadyDeleted) {
          let status: Awaited<ReturnType<typeof request>>;
          try {
            status = await request("status");
          } catch (error) {
            if (code !== "request_failed") throw error;
            await pause();
            continue;
          }
          if (!status.ok && httpStatus === 404 && code === "not_found") {
            alreadyDeleted = true;
            break;
          }
          if (!status.ok) {
            if (!RETRY_CODES.has(code)) throw Error(code);
            await pause();
            continue;
          }
          if (status.body?.id !== row.id) throw Error(code);
          if (status.body?.status === "deleted") {
            alreadyDeleted = true;
            break;
          }
          if (status.body?.status === "stopped" || status.body?.status === "failed") break;
          if (!["starting", "ready", "running", "stopping"].includes(String(status.body?.status))) throw Error(code);
          code = "stop_not_terminal";
          await pause();
          if (retryStopAdmission && (status.body?.status === "ready" || status.body?.status === "running"))
            await dispatchStop();
          if (status.body?.status === "stopping") retryStopAdmission = false;
        }
      }
      await stopAndObserve();
      onStopped?.();
      if (!alreadyDeleted) {
        // Child delete needs the durable authority fence from parent deletion.
        if (scoped) await parentWave;
        let recheckedStop = false;
        while (true) {
          let deleted: Awaited<ReturnType<typeof request>>;
          try {
            deleted = await request("delete");
          } catch (error) {
            if (code !== "request_failed") throw error;
            await pause();
            continue;
          }
          if (!deleted.ok && httpStatus === 404 && code === "not_found") break;
          if (deleted.ok && deleted.body?.id === row.id && deleted.body.status === "deleted") break;
          if (!RETRY_CODES.has(code) && !(deleted.ok && deleted.body?.id === row.id)) throw Error(code);
          io.out(JSON.stringify({ step: "delete_smoke_sandbox_retry", ...row, phase, httpStatus, code }));
          // A delegated message dispatched before parent stop can still resume a child
          // during overlapping cleanup. Re-stop only after observing renewed activity.
          if (scoped && !recheckedStop && httpStatus === 409 && code === "conflict") {
            recheckedStop = true;
            const status = await request("status").catch(() => null);
            if (status?.ok && status.body?.id === row.id && ["ready", "running"].includes(String(status.body.status))) {
              await stopAndObserve();
              if (alreadyDeleted) break;
              continue;
            }
            phase = "delete";
            httpStatus = 409;
            code = "conflict";
          }
          // Pending deletes are reconciled by repeating the same idempotent delete.
          await pause();
        }
      }
      io.out(JSON.stringify({ step: "delete_smoke_sandbox", pass: true, ...row }));
    } catch {
      remaining.push(row);
      io.out(JSON.stringify({ step: "delete_smoke_sandbox", pass: false, ...row, phase, httpStatus, code }));
    }
  };
  const parentStops: Promise<boolean>[] = [];
  const parentDeletes = selected
    .filter((row) => !row.requestKey.startsWith("smoke-scoped-"))
    .map((row) => {
      const stopped = Promise.withResolvers<boolean>();
      parentStops.push(stopped.promise);
      return cleanup(row, false, () => stopped.resolve(true)).finally(() => stopped.resolve(false));
    });
  const parentWave = Promise.all(parentDeletes).then(() => {
    parentFinishedAt = now();
  });
  // A live parent can resume its child. Overlap only once ordinary stop is
  // confirmed. If a refusal leaves stop uncertain, keep the original ordering.
  if (!(await Promise.all(parentStops)).every(Boolean)) await parentWave;
  await Promise.all([
    parentWave,
    ...selected.filter((row) => row.requestKey.startsWith("smoke-scoped-")).map((row) => cleanup(row, true)),
  ]);
  return remaining;
}
