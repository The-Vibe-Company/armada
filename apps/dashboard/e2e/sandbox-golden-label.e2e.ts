import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { IDS, reset, signIn } from "./helpers";

const origin = "http://127.0.0.1:3102";
const ACME = "00000000-0000-4000-8000-000000000010";
const GOLDEN = "00000000-0000-4000-8000-000000000020";
let directory: string;
let server: ChildProcess;

// Browser routing cannot see RSC's backend reads. Observe the real server's fetch boundary in a separate
// app process, leaving the shared mock (including its RLS/filter/projection behavior) untouched.
test.use({ baseURL: origin });
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "golden-label-"));
  const preload = join(directory, "observe.cjs");
  await writeFile(
    preload,
    `const fs = require('node:fs');
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.pathname !== '/rest/v1/goldens') return original(input, init);
  fs.appendFileSync(${JSON.stringify(join(directory, "reads"))}, url.href + '\\n');
  const mode = fs.readFileSync(${JSON.stringify(join(directory, "mode"))}, 'utf8');
  if (mode === 'error') return new Response(JSON.stringify({message: 'Golden label unavailable'}), {status: 500});
  const response = await original(input, init);
  if (mode === 'live' || !response.ok) return response;
  const rows = await response.json();
  return Response.json(mode === 'unreadable' ? [] : rows.map(row => ({...row, removed_at: '2026-11-10T00:00:00Z'})));
};`,
  );
  await writeFile(join(directory, "reads"), "");
  await writeFile(join(directory, "mode"), "live");
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3102", "-H", "127.0.0.1"], {
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${preload}`,
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54399",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-anon-key",
      ARMADA_MCP_URL: "http://127.0.0.1:54399/mcp",
      ARMADA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
    detached: true,
    stdio: "ignore",
  });
  await expect
    .poll(async () =>
      fetch(`${origin}/login`)
        .then((r) => r.status)
        .catch(() => 0),
    )
    .toBe(200);
});
test.afterAll(async () => {
  if (server?.pid) process.kill(-server.pid, "SIGTERM");
  if (directory) await rm(directory, { recursive: true, force: true });
});
test.beforeEach(async () => {
  await reset();
  await writeFile(join(directory, "reads"), "");
  await writeFile(join(directory, "mode"), "live");
});
const reads = async () => (await readFile(join(directory, "reads"), "utf8")).trim().split("\n").filter(Boolean);

for (const [mode, label] of [
  ["live", "shared-golden"],
  ["removed", "shared-golden (removed)"],
  ["unreadable", "Unknown"],
] as const) {
  test(`authorized detail reads only its golden label: ${mode}`, async ({ page }) => {
    await writeFile(join(directory, "mode"), mode);
    await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
    const fact = page.locator("dl > div").filter({ has: page.locator("dt", { hasText: /^Golden$/ }) });
    await expect(fact.locator("dd")).toHaveText(label);
    const requests = await reads();
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      const query = new URL(request).searchParams;
      expect([...query.entries()].sort()).toEqual([
        ["id", `eq.${GOLDEN}`],
        ["org_id", `eq.${ACME}`],
        ["select", "id,name,removed_at"],
      ]);
    }
  });
}

for (const restricted of [true, false]) {
  test(`${restricted ? "restricted" : "not-found"} detail never reads a golden`, async ({ page }) => {
    await signIn(page, "bob@example.com", "/settings");
    await writeFile(join(directory, "reads"), "");
    // Any accidental read would also fail: restricted metadata must not depend on this backend.
    await writeFile(join(directory, "mode"), "error");
    const response = await page.goto(`/sandboxes/${restricted ? IDS.running : "00000000-0000-4000-8000-000000000099"}`);
    if (restricted) await expect(page.locator("[data-restricted]")).toBeVisible();
    else expect(response?.status()).toBe(404);
    expect(await reads()).toEqual([]);
  });
}
