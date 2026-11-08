import { describe, expect, test } from "bun:test";
import { VERSION } from "@armada/core";
import { run } from "../src/run.ts";

async function capture(argv: string[]) {
  let out = "";
  let err = "";
  const code = await run(argv, { out: (text) => (out += text), err: (text) => (err += text) });
  return { code, out, err };
}

describe("run", () => {
  test("--version prints the version alone", async () => {
    expect(await capture(["--version"])).toEqual({ code: 0, out: `${VERSION}\n`, err: "" });
  });

  test("no command prints the help", async () => {
    const { code, out } = await capture([]);
    expect(code).toBe(0);
    expect(out).toContain("armada golden create");
    expect(out).toContain("armada launch <golden> --agent claude|codex");
    expect(out).toContain("armada login");
    expect(out).toContain("armada token create");
  });

  test("serve without its environment names what is missing and exits 2", async () => {
    let out = "";
    let err = "";
    const code = await run(["serve"], { out: (text) => (out += text), err: (text) => (err += text) }, { env: {} });
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("Set ARMADA_DATABASE_URL");
  });

  test("an unknown command fails with a usage error", async () => {
    const { code, out, err } = await capture(["frobnicate"]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("unknown command 'frobnicate'");
  });
});
