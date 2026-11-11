import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOLDEN_SKILLPACK_SETUP } from "../src/golden-skillpack.ts";

// Actual production shell, no network or root/system writes. The download boundary
// supplies either no bytes or corrupt bytes; real SHA-256 owns the integrity decision.
test.each(["offline", "corrupt"])("golden Skillpack provisioning %s", (mode) => {
  const home = mkdtempSync(join(tmpdir(), "golden-skillpack-"));
  try {
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "curl"),
      mode === "offline"
        ? "#!/bin/sh\nexit 7\n"
        : '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then printf corrupt > "$2"; exit 0; fi; shift; done\nexit 1\n',
      { mode: 0o755 },
    );
    const result = Bun.spawnSync(["bash", "-euc", GOLDEN_SKILLPACK_SETUP], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(result.exitCode).toBe(mode === "offline" ? 0 : 98);
    expect(result.stderr.toString()).toContain(
      mode === "offline" ? "ARMADA_BUILD_WARNING skillpack download_unavailable" : "ARMADA_BUILD_FAILURE skillpack 98",
    );
    expect(existsSync(join(home, ".local/bin/skillpack"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
