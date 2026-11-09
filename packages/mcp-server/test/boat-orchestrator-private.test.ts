import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boatOrchestratorBridgeScript } from "../src/boat-orchestrator-bridge.ts";
import { boatOrchestratorControlScript } from "../src/boat-orchestrator-script.ts";

test("Boat private epoch script rejects older writes/boot mismatch and exact hash cleanup preserves newer authority without disk secrets", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-boat-epoch-"));
  const sandboxId = `synthetic-${crypto.randomUUID()}`;
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const control = crypto.randomUUID();
  const one = `armada_epoch_${"a".repeat(64)}`,
    three = `armada_epoch_${"b".repeat(64)}`;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const run = async (payload: Record<string, unknown>, script = boatOrchestratorControlScript) => {
    const child = Bun.spawn(["bash"], {
      stdin: new Blob([script]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, ARMADA_GIT_TOKEN: JSON.stringify({ sandboxId, boot, control, ...payload }) },
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    for (const value of [one, three, control]) {
      expect(stdout).not.toContain(value);
      expect(stderr).not.toContain(value);
    }
    const encoded = /^ARMADA_ORCHESTRATOR_RECEIPT ([A-Za-z0-9_-]+)$/m.exec(stdout)?.[1];
    const receipt = encoded
      ? (JSON.parse(Buffer.from(encoded, "base64url").toString()) as {
          physicalGeneration: string;
          epoch: string;
          port: number;
          authorityInstalled: boolean;
        })
      : null;
    return { code, receipt };
  };
  try {
    const first = await run({ op: "install", epoch: "1", token: one, url: "https://armada.invalid/private/mcp" });
    expect(first.code).toBe(0);
    expect(first.receipt?.physicalGeneration).toBe(boot);
    const current = await run({ op: "install", epoch: "3", token: three, url: "https://armada.invalid/private/mcp" });
    expect(current.code).toBe(0);
    expect(current.receipt?.epoch).toBe("3");
    expect(
      (await run({ op: "install", epoch: "2", token: one, url: "https://armada.invalid/private/mcp" })).code,
    ).not.toBe(0);
    expect((await run({ op: "scrub", hash: hash(one) })).receipt?.authorityInstalled).toBe(true);
    expect((await run({ op: "scrub", boot: "00000000-0000-0000-0000-000000000000" })).code).not.toBe(0);
    expect((await run({ op: "probe" })).receipt?.authorityInstalled).toBe(true);
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ theme: "dark", mcpServers: { own: { command: "untouched" } } }),
    );
    expect((await run({ port: current.receipt?.port }, boatOrchestratorBridgeScript)).code).toBe(0);
    const claude = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    expect(claude.theme).toBe("dark");
    expect(claude.mcpServers.own.command).toBe("untouched");
    expect(claude.mcpServers.armada_orchestrator.url).toBe(`http://127.0.0.1:${current.receipt?.port}/mcp`);
    expect((await run({ op: "scrub", hash: hash(three) })).receipt?.authorityInstalled).toBe(false);
    expect(
      (await run({ op: "install", epoch: "3", token: three, url: "https://armada.invalid/private/mcp" })).code,
    ).not.toBe(0);
    const state = join(
      "/dev/shm",
      `armada-orchestrator-${process.getuid?.()}`,
      createHash("sha256").update(sandboxId).digest("hex").slice(0, 24) + ".json",
    );
    const contents = [await readFile(state, "utf8")];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) await walk(p);
        else contents.push(await readFile(p, "utf8"));
      }
    };
    await walk(home);
    for (const value of [one, three, control]) expect(contents.join("")).not.toContain(value);
  } finally {
    await run({ op: "scrub" });
    await run({ op: "shutdown" });
    const prefix = join(
      "/dev/shm",
      `armada-orchestrator-${process.getuid?.()}`,
      createHash("sha256").update(sandboxId).digest("hex").slice(0, 24),
    );
    await rm(prefix + ".json", { force: true });
    await rm(prefix + ".sock", { force: true });
    await rm(home, { recursive: true, force: true });
  }
});
