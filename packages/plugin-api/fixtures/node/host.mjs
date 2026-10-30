// Host-side, headless node for runtime conformance. It drives real git and child processes.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export function fixtureNode(directory) {
  const workers = new Map();
  const get = (ref) => {
    const row = workers.get(ref.handle);
    if (!row || JSON.stringify(row.ref) !== JSON.stringify(ref)) throw new Error("Invalid fixture worker");
    return row;
  };
  return {
    async prepare({ repository, branch, signal }) {
      const path = join(directory, `host-node-${randomUUID()}`);
      await mkdir(directory, { recursive: true });
      await execute("git", ["clone", "--quiet", repository, path], { signal });
      await execute("git", ["-C", path, "switch", "--quiet", "-c", branch], { signal });
      return { id: randomUUID(), path, node: "fixture" };
    },
    async launch({ workspace, worker, command, args, env }) {
      const ref = { ...worker, handle: randomUUID() };
      const child = spawn(command, args, { cwd: workspace.path, env: { ...process.env, ...env }, stdio: "pipe" });
      const row = { ref, child, state: "starting", reply: "", keys: new Map() };
      workers.set(ref.handle, row);
      row.done = new Promise((resolve) => {
        child.on("close", (code) => {
          row.state = code === 0 || row.stopping ? "stopped" : "failed";
          resolve();
        });
      });
      for (const output of [child.stdout, child.stderr])
        output.on("data", (chunk) => {
          row.reply = (row.reply + chunk).slice(-65536);
        });
      child.stdin.on("error", () => {});
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      row.state = "running";
      return ref;
    },
    async deliver(ref, message, key) {
      const row = get(ref);
      if (row.keys.has(key)) {
        if (row.keys.get(key) !== message) throw new Error("Delivery key reused");
        return;
      }
      if (row.state !== "running") throw new Error("Worker ended");
      row.keys.set(key, message);
      await new Promise((resolve, reject) =>
        row.child.stdin.write(`${message}\n`, (error) => (error ? reject(error) : resolve())),
      );
    },
    async observe(ref) {
      const row = get(ref);
      return { state: row.state, reply: row.reply };
    },
    async stop(ref) {
      const row = get(ref);
      if (row.state === "stopped" || row.state === "failed") return;
      row.stopping = true;
      row.child.kill("SIGTERM");
      const timer = setTimeout(() => row.child.kill("SIGKILL"), 1000);
      try {
        await row.done;
      } finally {
        clearTimeout(timer);
      }
    },
    async dispose(workspace) {
      await rm(workspace.path, { recursive: true, force: true });
    },
  };
}
