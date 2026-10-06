// Node-compatible fixture: the real detached adapter relaunches this entry.
import { watch } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseConfig } from "@armada/core";
import { memoryFleet } from "../../../core/test/memory-fleet.ts";
import { ARMADA_URL, fakeArmada, fakeClock, NOW } from "../../../core/test/support.ts";
import { loadCredentials } from "../../src/auth.ts";
import { run } from "../../src/cli.ts";
import { startDeploys } from "../../src/deploy.ts";
import type { Io } from "../../src/io.ts";
import { createExec, startBackground } from "../../src/spawn.ts";

const args = process.argv.slice(2);
const child = args[0] === "deploy";
const configPath = child ? (args[args.indexOf("--config") + 1] as string) : (args[0] as string);
const root = dirname(configPath);
const evidence = join(root, "result.json");
const text = await readFile(configPath, "utf8");
const store = memoryFleet();
const clock = fakeClock(NOW);
const api = fakeArmada({ keys: { armada_key_CANARY_deploy: "deploy" }, clock, store });
const out: string[] = [],
  err: string[] = [];
const exec = createExec();
const abort = new AbortController();
const io: Io = {
  cwd: root,
  // A caller's Io environment must reach the detached process, including its machine root.
  env: {
    ...process.env,
    XDG_CONFIG_HOME: child ? (process.env.XDG_CONFIG_HOME ?? join(root, "child-default")) : join(root, "machine"),
    ARMADA_API_URL: ARMADA_URL,
    ARMADA_API_KEY: "armada_key_CANARY_deploy",
  },
  readFile: (path) => readFile(path, "utf8").catch(() => null),
  stdout: (s) => out.push(s),
  stderr: (s) => err.push(s),
  ghToken: () => null,
  fetch: api.fetch,
  now: clock.now,
  sleep: clock.sleep,
  exec: (command, args, options) =>
    exec(command, args, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 2_000, 2_000), signal: abort.signal }),
  startBackground,
  backgroundReady: (ready) => process.send?.({ ready }),
};
if (child) {
  const deadline = setTimeout(() => abort.abort(), 4_000);
  let code: number;
  try {
    code = await run(args, io);
  } finally {
    clearTimeout(deadline);
    abort.abort(); // Kill any in-flight command group before ending this detached fixture.
  }
  await writeFile(
    `${evidence}.tmp`,
    JSON.stringify({
      code,
      rows: await store.deployState("widgets", {}),
      holds: await store.openHolds("widgets"),
      out,
      err,
    }),
  );
  await rename(`${evidence}.tmp`, evidence);
} else {
  await run(["config", "set", "deploy.env.DEPLOY_LINK_DIR", "synthetic-linked-folder"], io);
  const credentials = (await loadCredentials(io, { armada: false })).credentials;
  let cleanup = () => {};
  const finished = new Promise<void>((resolve, reject) => {
    const watcher = watch(root, (_event, name) => {
      if (name === "result.json") {
        cleanup();
        resolve();
      }
    });
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error("detached fixture did not write evidence"));
    }, 6_000);
    cleanup = () => {
      clearTimeout(deadline);
      watcher.close();
    };
    watcher.once("error", (err) => {
      cleanup();
      reject(err);
    });
  });
  // A failed startup can precede awaiting evidence; keep that rejection handled.
  void finished.catch(() => {});
  try {
    const result = await startDeploys(io, parseConfig(text), credentials, configPath, "a".repeat(40), ["api"], false);
    if (!result[0]?.started) throw new Error("detached fixture did not start");
    await finished;
    const body = await readFile(evidence, "utf8");
    process.stdout.write(JSON.stringify({ started: true, child: JSON.parse(body) }));
  } finally {
    cleanup();
  }
}
