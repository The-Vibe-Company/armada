import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARMADA_URL, DEMO_TOML, fakeArmada, NOW } from "../../core/test/support.ts";
import { type Io, run } from "../src/cli.ts";

test("digest JSON, French default, duration override and send use only the signed-in fleet API", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-digest-"));
  try {
    const key = "armada_key_TEST_digest";
    let sends = 0;
    const api = fakeArmada({
      keys: { [key]: "digest test" },
      sendDigest: async (_project, _digest, language) => {
        expect(language).toBe("fr");
        sends++;
        return true;
      },
    });
    let out = "";
    let err = "";
    const io: Io = {
      cwd: "/work/widgets",
      env: { XDG_CONFIG_HOME: home, ARMADA_API_KEY: key, ARMADA_API_URL: ARMADA_URL },
      readFile: async (path) =>
        path === "/work/widgets/armada.toml" ? DEMO_TOML.replace("[tracker]", '[tracker]\nlanguage = "fr"') : null,
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
      ghToken: () => null,
      fetch: api.fetch,
      now: () => NOW,
    };
    expect(await run(["digest", "--since", "4h", "--json"], io)).toBe(0);
    expect(JSON.parse(out).digest.since).toBe("2026-03-04T06:00:00.000Z");
    expect(JSON.parse(out).text).toContain("Rien de nouveau");
    expect(api.calls.map((c) => c.path)).toEqual(["fleet/digest"]);
    out = "";
    expect(await run(["digest", "--send", "--json"], io)).toBe(0);
    expect(JSON.parse(out).sent).toBe(true);
    expect(sends).toBe(1);
    expect(api.calls.at(-1)?.path).toBe("fleet/digest/send");
    out = "";
    expect(await run(["digest", "--lang", "en"], io)).toBe(0);
    expect(out).toContain("Nothing new");
    expect(await run(["digest", "--since", "tomorrow"], io)).toBe(2);
    expect(err).toContain("--since");
    expect(await run(["digest", "--lang", "de"], io)).toBe(2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
