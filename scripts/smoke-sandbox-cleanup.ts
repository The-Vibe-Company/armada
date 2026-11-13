import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const STAGING_ORIGIN = "https://armada-mcp-staging.up.railway.app";
export interface SmokeSandboxReceipt {
  requestKey: string;
  org: string;
  id: string;
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
    return { id: row.id, org: row.org, requestKey: row.requestKey };
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

export async function deleteSmokeReceipts(
  origin: string,
  token: string,
  rows: SmokeSandboxReceipt[],
  io: { fetch: (url: string, init: RequestInit) => Promise<Response>; out: (line: string) => void },
  limit = 32,
): Promise<SmokeSandboxReceipt[]> {
  if (origin !== STAGING_ORIGIN) throw new Error("staging_only");
  const remaining: SmokeSandboxReceipt[] = [];
  await Promise.all(
    rows.map(async (row, index) => {
      if (index >= limit) {
        remaining.push(row);
        return;
      }
      try {
        for (const action of ["stop", "delete"]) {
          const response = await io.fetch(`${origin}/api/v1/sandbox/${action}`, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ org: row.org, id: row.id }),
          });
          const body = (await response.json()) as { id?: string; status?: string; error?: { code?: string } };
          // Already-deleted resources may reject stop. Delete is the authoritative receipt.
          if (action === "delete" && (!response.ok || body.id !== row.id || body.status !== "deleted"))
            throw new Error("delete_unconfirmed");
        }
        io.out(JSON.stringify({ step: "delete_smoke_sandbox", pass: true, ...row }));
      } catch {
        remaining.push(row);
        io.out(JSON.stringify({ step: "delete_smoke_sandbox", pass: false, ...row }));
      }
    }),
  );
  return remaining;
}
