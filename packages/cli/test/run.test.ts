import { describe, expect, test } from "bun:test";
import { VERSION } from "@armada/core";
import { run } from "../src/run.ts";

function capture(argv: string[]) {
  let out = "";
  let err = "";
  const code = run(argv, { out: (text) => (out += text), err: (text) => (err += text) });
  return { code, out, err };
}

describe("run", () => {
  test("--version prints the version alone", () => {
    expect(capture(["--version"])).toEqual({ code: 0, out: `${VERSION}\n`, err: "" });
  });

  test("no command prints the help", () => {
    const { code, out } = capture([]);
    expect(code).toBe(0);
    expect(out).toContain("armada --version");
  });

  test("an unknown command fails with a usage error", () => {
    const { code, out, err } = capture(["launch"]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("unknown command 'launch'");
  });
});
