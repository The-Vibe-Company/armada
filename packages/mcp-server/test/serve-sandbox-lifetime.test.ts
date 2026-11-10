import { test } from "bun:test";
import { resolve } from "node:path";

// Child isolation contains the SDK mocks. The fixture assertions own real serve routing,
// provider deadline confirmation and worker stop ordering, which helper-only tests cannot prove.
test("serve extends and safely expires idle and running sandboxes through both real provider adapters", async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/serve-sandbox-lifetime.ts")], {
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
    if (code !== 0) throw Error(`Isolated serve lifetime acceptance failed:\n${err}\n${out}`);
  } finally {
    clearTimeout(deadline);
    child.kill();
  }
}, 60_000);
