import { expect, test } from "bun:test";
import { reviewRuntimeChecks } from "../src/doctor.ts";
import type { Exec, Io } from "../src/io.ts";

test("doctor diagnoses review prerequisites without installing or executing OCR", async () => {
  const calls: string[][] = [];
  let python: string | null = "Python 3.11.9";
  let git = "git version 2.43.0";
  let cache = { code: 2, stdout: "OCR 1.12.1 needs its first GitHub download", stderr: "" };
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git") return { code: 0, stdout: git, stderr: "" };
    if (args[0] === "--version") {
      if (python === null) throw new Error("not found");
      return { code: 0, stdout: "", stderr: python };
    }
    expect(command).toBe("python3");
    expect(args[0]).toBe("-c");
    expect(args[1]).toContain("def check_setup");
    expect(args[2]).toBe("check");
    return cache;
  };
  const io = { cwd: "/work/widgets", exec } as Io;
  const levels = async () => Object.fromEntries((await reviewRuntimeChecks(io, io.cwd)).map((c) => [c.id, c.level]));
  expect(await levels()).toEqual({ "review-python": "ok", "review-git": "ok", "review-ocr": "warning" });
  cache = { code: 0, stdout: "OCR 1.12.1 cached binary verified", stderr: "" };
  expect((await levels())["review-ocr"]).toBe("ok");
  cache = { code: 1, stdout: "", stderr: "OCR checksum mismatch; refusing to execute" };
  expect((await reviewRuntimeChecks(io, io.cwd)).find((c) => c.id === "review-ocr")).toMatchObject({
    level: "warning",
    message: expect.stringContaining("checksum mismatch"),
  });
  python = "Python 3.8.20";
  git = "git version 2.40.0";
  calls.length = 0;
  expect(await levels()).toEqual({ "review-python": "warning", "review-git": "warning" });
  expect(calls.every((c) => c[1] === "--version")).toBe(true);
  python = null;
  expect((await levels())["review-python"]).toBe("warning");
});
