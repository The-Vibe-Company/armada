import { expect, test } from "bun:test";
import { globToRegExp, overlaps } from "../src/overlap.ts";

test("declared paths compare files and globs conservatively, and never hide incomplete readings", () => {
  const other = (plan: string[], files: string[] | null = [], filesComplete = true) => ({
    ticket: "DEMO-7",
    pr: 45,
    plan,
    files,
    filesComplete,
  });
  expect(overlaps(["src/a.ts"], [other([], ["src/a.ts", "src/b.ts"])])).toEqual([
    { ticket: "DEMO-7", pr: 45, paths: ["src/a.ts"], incomplete: false },
  ]);
  expect(overlaps(["src/*.ts"], [other([], ["src/a.ts", "src/deep/b.ts"])])[0]?.paths).toEqual(["src/*.ts"]);
  expect(overlaps(["src/deep/a.ts"], [other(["src/**"])])[0]?.paths).toEqual(["src/deep/a.ts"]);
  expect(overlaps(["src/**"], [other(["src/deep/*.ts"])])[0]?.paths).toEqual(["src/**"]);
  expect(overlaps(["docs/**"], [other(["src/**"])])).toEqual([]);
  expect(overlaps(["docs/a.md"], [other([], ["src/a.ts"], false)])).toEqual([
    { ticket: "DEMO-7", pr: 45, paths: [], incomplete: true },
  ]);
  expect(overlaps(["docs/a.md"], [other([], null, false)])[0]?.incomplete).toBe(true);
  expect(globToRegExp("src/**/a?.ts").test("src/a1.ts")).toBe(true);
  expect(globToRegExp("src/**/a?.ts").test("src/deep/a1.ts")).toBe(true);
  expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false);
  expect(globToRegExp("src/a+.ts").test("src/a+.ts")).toBe(true);
});
