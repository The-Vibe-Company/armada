import { expect, test } from "bun:test";
import { checkDocsFiles } from "./docs-guard.ts";

test("reports new oversized docs by path and permits text at the limit", () => {
  expect(
    checkDocsFiles(
      [
        { path: "docs/large.md", size: 300_000, read: () => Buffer.alloc(300_000, "a") },
        { path: "docs/limit.md", size: 200_000, read: () => Buffer.alloc(200_000, "a") },
      ],
      new Map(),
    ),
  ).toEqual(["docs/large.md: 300000 bytes exceeds 200000 bytes"]);
});

test("rejects media extensions and binary content even for small files", () => {
  expect(
    checkDocsFiles(
      [
        { path: "docs/nested/diagram.SVG", size: 6, read: () => Buffer.from("<svg/>") },
        { path: "docs/sample.md", size: 3, read: () => Buffer.from([0xff, 0xd8, 0xff]) },
      ],
      new Map(),
    ),
  ).toEqual(["docs/nested/diagram.SVG: images and videos are forbidden", "docs/sample.md: expected UTF-8 text"]);
});

test("grandfathers only the original content at an allowlisted path", () => {
  const allowlist = new Map([["docs/old.svg", "d4dc56669143034f31aa309635d4113d9ad76a02b1739da22c965ed2049be9e6"]]);
  const file = { path: "docs/old.svg", size: 6, read: () => Buffer.from("<svg/>") };
  expect(checkDocsFiles([file], allowlist)).toEqual([]);
  expect(checkDocsFiles([{ ...file, read: () => Buffer.from("<svg />") }], allowlist)).toEqual([
    "docs/old.svg: images and videos are forbidden",
  ]);
});

test("requires removal of stale allowlist entries", () => {
  expect(checkDocsFiles([], new Map([["docs/removed.png", "old_hash"]]))).toEqual([
    "docs/removed.png: remove the unused docs allowlist entry",
  ]);
});
