import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { constants } from "node:fs";
import { runInNewContext } from "node:vm";
import { runtimeBootstrapScript } from "../src/runtime-bootstrap.ts";

async function flushMicrotasks(rounds = 100) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function makeFixture(mode: "warm" | "shared" | "download-failure") {
  const executable = Buffer.from("verified runtime binary");
  const artifact = {
    sha256: crypto.createHash("sha256").update(executable).digest("hex"),
    bytes: executable.byteLength,
  };
  const cacheDir = "/cache";
  const sharedDir = "/opt/armada/artifact-cache";
  const targetPath = `${cacheDir}/${artifact.sha256}`;
  const sharedPath = `${sharedDir}/${artifact.sha256}`;
  const files = new Map<string, Buffer>();
  if (mode === "warm") files.set(targetPath, executable);
  if (mode === "shared") files.set(sharedPath, executable);

  const events: string[] = [];
  const pendingProgress: { stage: string; resolve: () => void }[] = [];
  const spawned: { path: string; args: string[]; stdin: string }[] = [];
  const processObj = { exitCode: 0 };
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const script = runtimeBootstrapScript(
    "https://armada.example",
    artifact,
    cacheDir,
    mode === "shared" ? sharedDir : undefined,
  );

  const fsPromises = {
    async lstat(path: string) {
      if (path === "/home/user") return { uid: 1000, gid: 1000 };
      if (path === cacheDir) return { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40700 };
      if (path === targetPath) {
        events.push("verify:target");
        const data = files.get(path);
        if (!data) throw enoent();
        return { isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: data.byteLength };
      }
      throw enoent();
    },
    async mkdir() {},
    async open(path: string, flags: string | number) {
      if (flags === "wx") {
        const chunks: Buffer[] = [];
        return {
          writeFile: async (chunk: Uint8Array) => void chunks.push(Buffer.from(chunk)),
          chmod: async () => {},
          chown: async () => {},
          sync: async () => {},
          close: async () => void files.set(path, Buffer.concat(chunks)),
        };
      }
      if (path === sharedPath) events.push("verify:shared");
      const data = files.get(path);
      if (!data) throw enoent();
      return {
        stat: async () => ({ isFile: () => true, size: data.byteLength }),
        createReadStream: () => [data],
        close: async () => {},
      };
    },
    async rename(from: string, to: string) {
      const data = files.get(from);
      if (!data) throw enoent();
      files.set(to, data);
      files.delete(from);
    },
    rm: async (path: string) => void files.delete(path),
    chmod: async () => {},
    chown: async () => {},
  };

  let settled = false;
  const runPromise = (
    runInNewContext(script, {
      AbortSignal,
      process: processObj,
      fetch: (url: string, init?: { body?: string }) => {
        if (!url.endsWith("/api/runtime/progress")) return Promise.resolve(new Response(null, { status: 500 }));
        const { stage } = JSON.parse(init?.body ?? "{}") as { stage: string };
        events.push(`progress:${stage}`);
        return new Promise<Response>((resolve) =>
          pendingProgress.push({ stage, resolve: () => resolve(new Response("{}")) }),
        );
      },
      require: (module: string) => {
        if (module === "node:crypto") return crypto;
        if (module === "node:fs")
          return {
            constants,
            readFileSync: () => JSON.stringify({ serverUrl: "https://armada.example", enrolmentToken: "tok" }),
          };
        if (module === "node:fs/promises") return fsPromises;
        if (module === "node:child_process")
          return {
            spawn(path: string, args: string[]) {
              events.push("spawn");
              return {
                once: (event: string, handler: () => void) => event === "spawn" && handler(),
                stdin: {
                  once: () => {},
                  end: (data: string, done: () => void) => {
                    spawned.push({ path, args, stdin: data });
                    done();
                  },
                },
                unref: () => {},
              };
            },
          };
        throw new Error(`Unexpected module: ${module}`);
      },
    }) as Promise<void>
  ).finally(() => {
    settled = true;
  });

  return {
    targetPath,
    events,
    pendingProgress,
    spawned,
    processObj,
    runPromise,
    isSettled: () => settled,
    resolveAllProgress: () => {
      for (const item of pendingProgress) item.resolve();
    },
  };
}

describe("runtimeBootstrapScript", () => {
  test.each(["warm", "shared"] as const)(
    "starts bootstrap_started concurrently and spawns runtime without blocking on artifact_verified (%s)",
    async (mode) => {
      const f = makeFixture(mode);
      try {
        await flushMicrotasks();
        expect(f.isSettled()).toBe(true);
        expect(f.processObj.exitCode).toBe(0);
        expect(f.spawned).toEqual([
          {
            path: f.targetPath,
            args: ["dialout"],
            stdin: JSON.stringify({ serverUrl: "https://armada.example", enrolmentToken: "tok" }),
          },
        ]);
        expect(f.pendingProgress.map((p) => p.stage)).toEqual(["bootstrap_started", "artifact_verified"]);
        expect(f.events).toEqual([
          "progress:bootstrap_started",
          "verify:target",
          ...(mode === "shared" ? ["verify:shared"] : []),
          "progress:artifact_verified",
          "spawn",
        ]);
      } finally {
        f.resolveAllProgress();
        await f.runPromise;
      }
    },
  );

  test("awaits bootstrap_failed before exiting with code 1 when artifact installation fails", async () => {
    const f = makeFixture("download-failure");
    try {
      await flushMicrotasks();
      expect(f.pendingProgress.map((p) => p.stage)).toEqual(["bootstrap_started", "bootstrap_failed"]);
      expect(f.isSettled()).toBe(false);
      expect(f.processObj.exitCode).toBe(0);
      expect(f.spawned).toEqual([]);
      f.pendingProgress.find((p) => p.stage === "bootstrap_failed")?.resolve();
      await f.runPromise;
      expect(f.isSettled()).toBe(true);
      expect(f.processObj.exitCode).toBe(1);
    } finally {
      f.resolveAllProgress();
      await f.runPromise;
    }
  });
});
