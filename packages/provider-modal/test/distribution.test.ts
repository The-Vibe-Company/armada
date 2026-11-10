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

(process.platform === "linux" ? test : test.skip)(
  "fresh saved-golden fork receives current verified runtime without editing native state or restored code",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-runtime-overlay-"));
    const runtime = join(root, "runtime");
    const globalBun = join(root, "global-bun");
    const bundle = Buffer.from("// current server runner\n");
    const digest = createHash("sha256").update(bundle).digest("hex");
    execFileSync("sudo", ["mkdir", "-p", runtime]);
    execFileSync("sudo", ["cp", process.execPath, globalBun]);
    execFileSync("sudo", ["chmod", "555", globalBun]);
    execFileSync("sudo", ["chown", "-R", "0:0", root]);
    execFileSync("sudo", ["chmod", "755", root]);
    let calls = 0;
    const sdk = {
      async exec(argv: string[]) {
        calls++;
        const child = Bun.spawn(
          [
            "sudo",
            "-n",
            ...argv.map((arg) =>
              arg
                .replaceAll("/opt/armada", runtime)
                .replaceAll("'/opt'", JSON.stringify(root))
                .replaceAll("/usr/local/lib/node_modules/bun/bin/bun.exe", globalBun),
            ),
          ],
          { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
        );
        return {
          stdin: {
            writeText: async (text: string) => {
              child.stdin.write(text);
            },
            close: async () => {
              child.stdin.end();
            },
          },
          stdout: { readText: () => new Response(child.stdout).text() },
          wait: () => child.exited,
        };
      },
    } as unknown as import("modal").Sandbox;
    const distribution = createRunnerDistribution({
      ...MODAL_IMAGE_LOCK,
      bundle,
      sha256: digest,
      capabilities: {} as RunnerDistribution["capabilities"],
      bootstrap: async () => {
        throw Error("No private bootstrap before artifact installation");
      },
      restoreEnv: async () => ({}),
      prepareSnapshot: async () => {},
    });
    const fresh = { generation: 1, golden: false } as import("../src/ports.ts").Machine;
    try {
      execFileSync("sudo", ["sh", "-c", 'printf "%s" "old snapshot runner" > "$1/main.js"', "sh", runtime]);
      await distribution.prepareRuntime?.(sdk, fresh);
      expect(await Bun.file(join(runtime, "main.js")).text()).toBe(bundle.toString());
      expect(execFileSync(join(runtime, "runtime-bun/bun"), ["--version"], { encoding: "utf8" }).trim()).toBe("1.4.2");
      const before = calls;
      await distribution.prepareRuntime?.(sdk, { ...fresh, generation: 2 });
      expect(calls).toBe(before); // No code change during native checkpoint restore.
      await distribution.prepareRuntime?.(sdk, { ...fresh, freshStatePreparedGeneration: 1 });
      expect(calls).toBe(before); // An uncertain same-generation bootstrap must not be rewritten either.
      const userFile = join(root, "keep-native-state");
      execFileSync("sudo", ["sh", "-c", 'printf "%s" "native state untouched" > "$1"', "sh", userFile]);
      execFileSync("sudo", ["rm", join(runtime, "main.js")]);
      execFileSync("sudo", ["ln", "-s", userFile, join(runtime, "main.js")]);
      await expect(distribution.prepareRuntime?.(sdk, fresh)).rejects.toMatchObject({ code: "conflict" });
      expect(await Bun.file(userFile).text()).toBe("native state untouched");
    } finally {
      execFileSync("sudo", ["rm", "-rf", "--", root]);
    }
  },
);
