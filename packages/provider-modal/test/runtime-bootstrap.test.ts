import { expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { runtimeBootstrapScript } from "@armada/core/server";

test.each([
  { sharedBytes: "verified runtime", downloads: 0 },
  { sharedBytes: "tampered runtime", downloads: 1 },
])(
  "Modal bootstrap verifies shared bytes before execution ($downloads HTTP transfers)",
  async ({ sharedBytes, downloads }) => {
    const root = await fs.mkdtemp(join(tmpdir(), "modal-bootstrap-"));
    try {
      const executable = "verified runtime";
      const artifact = {
        sha256: crypto.createHash("sha256").update(executable).digest("hex"),
        bytes: Buffer.byteLength(executable),
      };
      const shared = join(root, "shared");
      await fs.writeFile(shared, sharedBytes);
      const cache = join(root, "private");
      const launched: string[] = [];
      const requested: string[] = [];
      const process = { exitCode: 0 };
      await runInNewContext(
        runtimeBootstrapScript("https://armada.example", artifact, cache, "/opt/armada/artifact-cache"),
        {
          AbortSignal,
          process,
          fetch: (url: string) => {
            if (url.endsWith("/progress")) return new Response();
            requested.push(url);
            return new Response(executable);
          },
          require: (module: string) => {
            switch (module) {
              case "node:crypto":
                return crypto;
              case "node:fs":
                return { constants, readFileSync: () => "{}" };
              case "node:fs/promises":
                return {
                  ...fs,
                  chown: async () => {},
                  lstat: (path: string) => fs.lstat(path === "/home/user" ? root : path),
                  open: (path: string, flags: string | number, mode?: number) =>
                    fs.open(path === `/opt/armada/artifact-cache/${artifact.sha256}` ? shared : path, flags, mode),
                };
              case "node:child_process":
                return {
                  spawn(path: string) {
                    launched.push(path);
                    return {
                      once: (event: string, handler: () => void) => {
                        if (event === "spawn") handler();
                      },
                      stdin: { once: () => {}, end: (_data: string, done: () => void) => done() },
                      unref: () => {},
                    };
                  },
                };
              default:
                throw new Error(`Unexpected bootstrap module: ${module}`);
            }
          },
        },
      );
      expect(process.exitCode).toBe(0);
      expect(requested).toEqual(downloads ? [`https://armada.example/api/runtime/artifacts/${artifact.sha256}`] : []);
      expect(launched).toEqual([join(cache, artifact.sha256)]);
      expect(await fs.readFile(join(cache, artifact.sha256), "utf8")).toBe(executable);
      expect(await fs.readdir(cache)).toEqual([artifact.sha256]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
