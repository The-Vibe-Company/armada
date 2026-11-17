import { expect, test } from "bun:test";
import {
  admitOutputs,
  parseCollectorOutput,
  parseOutputArchive,
  selectRetainedOutputs,
} from "../src/sandbox-outputs.ts";
import { tarArchive, tarEntry } from "./support/tar.ts";

const bytes = (n: number) => new Uint8Array(n);

test("collector output parsing refuses traversal, control characters and malformed base64", () => {
  const valid = JSON.stringify([{ name: "memo.pdf", base64: Buffer.from("document").toString("base64") }]);
  expect(Buffer.from(parseCollectorOutput(valid)[0]!.bytes).toString()).toBe("document");
  for (const name of ["../key", "/key", "a/b", "a\\b", "..", "a\n"])
    expect(() => parseCollectorOutput(JSON.stringify([{ name, base64: "" }]))).toThrow();
  expect(() => parseCollectorOutput(JSON.stringify([{ name: "memo", base64: "!" }]))).toThrow();
});

test("server admission bounds any provider's read by count, size and unique names", () => {
  expect(admitOutputs([{ name: "memo", bytes: bytes(32768) }])).toHaveLength(1);
  for (const files of [
    [
      { name: "memo", bytes: bytes(0) },
      { name: "memo", bytes: bytes(0) },
    ],
    [{ name: "memo", bytes: bytes(32769) }],
    Array.from({ length: 2 }, (_, i) => ({ name: String(i), bytes: bytes(20000) })),
    Array.from({ length: 33 }, (_, i) => ({ name: String(i), bytes: bytes(0) })),
    [{ name: "../key", bytes: bytes(0) }],
  ])
    expect(() => admitOutputs(files)).toThrow();
});

test("retained-disk selection keeps only bounded direct regular files of the declared directory", () => {
  const selected = selectRetainedOutputs([
    { path: "workspace/outputs/b.pdf", kind: "file", size: 20000 },
    { path: "/workspace/outputs/a.txt", kind: "file", size: 10 },
    { path: "workspace/outputs/c.bin", kind: "file", size: 20000 },
    { path: "workspace/outputs/link", kind: "symlink", size: 4 },
    { path: "workspace/outputs/sub", kind: "dir" },
    { path: "workspace/outputs/sub/x", kind: "file", size: 1 },
    { path: "workspace/outputs/huge", kind: "file", size: 40000 },
    { path: "workspace/secret", kind: "file", size: 1 },
    { path: "home/user/workspace/outputs/z", kind: "file", size: 1 },
  ]);
  expect(selected.map((entry) => entry.name)).toEqual(["a.txt", "b.pdf"]);
});

test("a declared-directory archive yields its bounded direct regular files whatever the path root", () => {
  const read = (archive: Uint8Array) =>
    parseOutputArchive(archive).map((file) => [file.name, Buffer.from(file.bytes).toString()]);
  // Paths relative to the directory, with the directory entry itself.
  expect(
    read(
      tarArchive(
        tarEntry("./", "", "5"),
        tarEntry("./final.pdf", "final"),
        tarEntry("./sub/", "", "5"),
        tarEntry("./sub/x", "nested"),
        tarEntry("./link", "", "2"),
        tarEntry("./hard", "", "1"),
        tarEntry("./big.bin", "b".repeat(40000)),
        tarEntry("./a.txt", "a"),
      ),
    ),
  ).toEqual([
    ["a.txt", "a"],
    ["final.pdf", "final"],
  ]);
  // Paths relative to the disk root, and a pax path longer than the ustar name field.
  const long = `${"n".repeat(150)}.md`;
  const pax = `path=workspace/outputs/${long}\n`;
  const record = `${pax.length + 4} ${pax}`;
  expect(
    read(
      tarArchive(
        tarEntry("workspace/outputs/", "", "5"),
        tarEntry("workspace/outputs/memo.txt", "memo"),
        tarEntry("PaxHeader", record, "x"),
        tarEntry("truncated-name", "long", "0"),
      ),
    ),
  ).toEqual([
    ["memo.txt", "memo"],
    [long, "long"],
  ]);
  // Count and byte bounds apply in name order; an empty directory is an empty, complete read.
  const many = Array.from({ length: 40 }, (_, i) => tarEntry(`f${String(i).padStart(2, "0")}`, "x"));
  expect(read(tarArchive(...many))).toHaveLength(32);
  expect(read(tarArchive(tarEntry("b", "b".repeat(20000)), tarEntry("a", "a".repeat(20000))))).toEqual([
    ["a", "a".repeat(20000)],
  ]);
  expect(read(tarArchive())).toEqual([]);
  // Truncated or malformed archives are refused, never read as a smaller directory.
  expect(() => parseOutputArchive(tarEntry("memo.txt", "memo").subarray(0, 512))).toThrow();
  expect(() => parseOutputArchive(new Uint8Array(100))).toThrow();
});
