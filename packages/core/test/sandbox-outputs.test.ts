import { expect, test } from "bun:test";
import { admitOutputs, parseCollectorOutput, selectRetainedOutputs } from "../src/sandbox-outputs.ts";

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
  const selected = selectRetainedOutputs(
    [
      { path: "workspace/outputs/b.pdf", kind: "file", size: 20000 },
      { path: "/workspace/outputs/a.txt", kind: "file", size: 10 },
      { path: "workspace/outputs/c.bin", kind: "file", size: 20000 },
      { path: "workspace/outputs/link", kind: "symlink", size: 4 },
      { path: "workspace/outputs/sub", kind: "dir" },
      { path: "workspace/outputs/sub/x", kind: "file", size: 1 },
      { path: "workspace/outputs/huge", kind: "file", size: 40000 },
      { path: "workspace/secret", kind: "file", size: 1 },
      { path: "home/user/workspace/outputs/z", kind: "file", size: 1 },
    ],
    true,
  );
  expect(selected?.map((entry) => entry.name)).toEqual(["a.txt", "b.pdf"]);
  expect(selectRetainedOutputs([], false)).toBeNull();
});
