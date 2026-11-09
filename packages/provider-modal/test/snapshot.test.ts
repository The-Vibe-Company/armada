import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "modal";
import { type Machine, prepareFilesystemSnapshot, prepareFreshFilesystem } from "../src/index.ts";

(process.platform === "linux" ? test : test.skip)(
  "golden cleanup refuses open SQLite, removes native/history only after closure, and recovery keeps sessions",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-golden-state-"));
    const runtime = join(root, ".armada-runtime");
    await mkdir(runtime);
    await mkdir(join(root, "repos"));
    await Bun.write(join(root, "repos", "keep"), "repository");
    await mkdir(join(root, ".claude"));
    await Bun.write(join(root, ".claude", "history.jsonl"), "synthetic native history");
    await mkdir(join(root, ".codex"));
    await Bun.write(join(root, ".codex", "session.json"), "synthetic session");
    const journal = new Database(join(runtime, "journal.sqlite"));
    journal.exec("create table history(value text);insert into history values('synthetic request')");
    let calls = 0;
    const sdk = {
      async exec(argv: string[]) {
        calls++;
        // Cloud quiescence is the first public SDK boundary. The actual deletion command must still
        // detect this deliberately open (unexpected legacy/root) SQLite FD, rather than trusting it.
        if (calls % 3 !== 0)
          return { stdin: { writeText: async () => {}, close: async () => {} }, wait: async () => 0 };
        const process = Bun.spawn(
          argv.map((arg) => arg.replaceAll("/home/user", root)),
          { cwd: root, stdout: "ignore", stderr: "ignore" },
        );
        return { wait: () => process.exited };
      },
    } as unknown as Sandbox;
    const machine: Machine = {
      info: { id: "logical", name: "builder", labels: {}, state: "stopping", providerState: "checkpoint" },
      generation: 1,
      phase: "checkpoint",
      golden: true,
      ttlSeconds: 60,
      physicalName: "physical",
      physicalId: "fixture",
      processBaseline: {
        version: 1,
        physicalId: "fixture",
        generation: 1,
        namespace: { pid: "fixture", mount: "fixture" },
        processes: [{ pid: 1, start: "1" }],
      },
    };
    try {
      await expect(prepareFilesystemSnapshot(sdk, machine)).rejects.toMatchObject({ code: "conflict" });
      expect(await Bun.file(join(runtime, "journal.sqlite")).exists()).toBe(true);
      expect(await Bun.file(join(root, ".claude", "history.jsonl")).exists()).toBe(true);
      journal.close();
      await prepareFilesystemSnapshot(sdk, machine);
      expect(await Bun.file(join(runtime, "journal.sqlite")).exists()).toBe(false);
      expect(await Bun.file(join(root, ".claude", "history.jsonl")).exists()).toBe(false);
      expect(await Bun.file(join(root, ".codex", "session.json")).exists()).toBe(false);
      expect(await Bun.file(join(root, "repos", "keep")).text()).toBe("repository");
      await mkdir(runtime);
      await Bun.write(join(runtime, "session-state.json"), "keep recovered native session");
      await expect(
        prepareFreshFilesystem(sdk, { ...machine, golden: false, generation: 2, phase: "booting" }),
      ).rejects.toMatchObject({ code: "conflict" });
      const before = calls;
      await prepareFilesystemSnapshot(sdk, { ...machine, golden: false });
      expect(calls).toBe(before + 2);
      expect(await Bun.file(join(runtime, "session-state.json")).text()).toBe("keep recovered native session");
    } finally {
      journal.close(false);
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
