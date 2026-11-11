import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("diagnostic probe exports only metadata and does not mutate guest state", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "boat-probe-")));
  try {
    const root = join(home, ".armada/native-usage");
    mkdirSync(join(home, ".armada"), { mode: 0o700 });
    mkdirSync(root, { mode: 0o700 });
    const marker = "PRIVATE_NATIVE_MATERIAL_NOT_A_CREDENTIAL";
    const ticket = "12345678-1234-1234-1234-123456789012";
    const path = join(root, `${ticket}.json`);
    const original = JSON.stringify({ session: marker, turn: marker, terminal: true, final: [{ private: marker }] });
    writeFileSync(path, original);
    writeFileSync(join(root, "pending.json"), JSON.stringify({ ticket, at: 0, digest: marker }));
    writeFileSync(join(root, "prompt-private-id.json"), JSON.stringify({ ticket }));
    const result = Bun.spawnSync(["python3", "-I", resolve("scripts/diagnostics/boat-usage-probe.py")], {
      env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const text = result.stdout.toString();
    expect(text).not.toContain(marker);
    expect(text).not.toContain(ticket);
    expect(text).not.toContain(home);
    expect(JSON.parse(text)).toMatchObject({
      stateReadable: true,
      pendingExpired: true,
      mappings: 1,
      ticketCount: 1,
      tickets: [
        { session: true, turn: true, terminal: true, invalid: false, fresh: false, finalCached: true, finalRows: 1 },
      ],
    });
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
