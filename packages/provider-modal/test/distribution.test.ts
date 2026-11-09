import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Image, ModalClient } from "modal";
import { createRunnerDistribution, MODAL_IMAGE_LOCK, type RunnerDistribution } from "../src/index.ts";

(process.platform === "linux" ? test : test.skip)(
  "image artifact RUNs replay in real Linux shells beyond MAX_ARG_STRLEN and verify bytes before publication",
  async () => {
    // Incompressible and larger than the real bundle's usual compressed size, forcing many chunks.
    const samples = [randomBytes(1024 * 1024)];
    const actual = Bun.file(join(import.meta.dir, "../../agent-runtime/dist/main.js"));
    if (await actual.exists()) samples.push(Buffer.from(await actual.arrayBuffer()));
    for (const bundle of samples) {
      const digest = createHash("sha256").update(bundle).digest("hex");
      // Red witness: Linux rejects the former single-command strategy before a shell can run it.
      try {
        execFileSync("/bin/sh", ["-c", `printf '%s' '${bundle.toString("base64")}' >/dev/null`]);
        throw Error("oversized shell argument unexpectedly succeeded");
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("E2BIG");
      }
      let commands: string[] = [];
      const image = {
        dockerfileCommands(value: string[]) {
          commands = value;
          return this;
        },
      } as unknown as Image;
      const client = { images: { fromRegistry: () => image } } as unknown as ModalClient;
      const capabilities = {} as RunnerDistribution["capabilities"]; // No harness operation is exercised at the image boundary.
      const distribution = createRunnerDistribution({
        ...MODAL_IMAGE_LOCK,
        bundle,
        sha256: digest,
        capabilities,
        bootstrap: async () => ({}),
        restoreEnv: async () => ({}),
        prepareSnapshot: async () => {},
      });
      await distribution.image(client);
      const root = await mkdtemp(join(tmpdir(), "armada-image-replay-"));
      try {
        // Skip the three OS/tool/user installation steps; replay all captured artifact steps verbatim
        // apart from mapping the image's installation directory to this isolated fixture directory.
        for (const instruction of commands) {
          if (instruction.startsWith("RUN ")) expect(Buffer.byteLength(instruction.slice(4))).toBeLessThan(48 * 1024);
        }
        const runs = commands.slice(3, -1);
        expect(runs.length).toBeGreaterThan(3);
        for (const run of runs) {
          expect(run.startsWith("RUN ")).toBe(true);
          expect(Buffer.byteLength(run)).toBeLessThan(48 * 1024);
          const command = run.slice(4).replaceAll("/opt/armada", root);
          execFileSync("/bin/sh", ["-c", command], { stdio: "pipe" });
        }
        expect(Buffer.from(await Bun.file(join(root, "main.js")).arrayBuffer())).toEqual(bundle);
        expect(await readdir(root)).toEqual(["main.js"]);
        // The same captured final RUN refuses a corrupt digest and cannot replace a published artifact.
        const final = runs.at(-1);
        if (!final) throw Error("missing artifact finalization");
        // Rehydrate only the scratch chunks, leaving the previously verified main.js in place.
        for (const run of runs.slice(0, -1))
          execFileSync("/bin/sh", ["-c", run.slice(4).replaceAll("/opt/armada", root)]);
        expect(() =>
          execFileSync(
            "/bin/sh",
            ["-c", final.slice(4).replace(digest, "0".repeat(64)).replaceAll("/opt/armada", root)],
            { stdio: "pipe" },
          ),
        ).toThrow();
        expect(
          createHash("sha256")
            .update(await Bun.file(join(root, "main.js")).bytes())
            .digest("hex"),
        ).toBe(digest);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
