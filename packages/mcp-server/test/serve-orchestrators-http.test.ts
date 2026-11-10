import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("actual serve composition routes the CLI/web/iOS owner API over HTTP without a runtime factory override", async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/serve-orchestrators-http.ts")], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", NODE_ENV: "test" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 45_000);
  deadline.unref();
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw Error(`Isolated serve HTTP regression failed:\n${err}\n${out}`);
    const line = out.split("\n").find((item) => item.startsWith("SERVE_HTTP_ROUTE_RECEIPT "));
    expect(line).toBeDefined();
    const receipt = JSON.parse(line!.slice("SERVE_HTTP_ROUTE_RECEIPT ".length));
    expect(receipt.baseline).toBe("green");
    expect(receipt.proxyRecovery).toBe(true);
    expect(receipt.replayProviderReads).toBe(0);
    expect(receipt.effects.allocations).toBe(2);
    expect(receipt.effects.allocationAttempts).toBe(2);
    expect(receipt.effects.terminations).toBe(1);
    expect(receipt.effects.modelCalls).toBe(0);
    expect(receipt.effects.epochInstalls).toBe(1);
    expect(
      receipt.routes.some(
        (route: { path: string; status: number }) => route.path.endsWith("/recover") && route.status === 202,
      ),
    ).toBe(true);
  } finally {
    clearTimeout(deadline);
    child.kill();
  }
}, 60_000);
