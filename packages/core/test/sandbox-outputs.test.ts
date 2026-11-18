import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitOutputs, OUTPUT_COLLECTOR, OUTPUT_MAX_ENTRIES, parseCollectorOutput } from "../src/sandbox-outputs.ts";

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

/** Runs the real collector against a fixture directory standing in for `/home/user/outputs`. */
function collectorFor(outputs: string) {
  return OUTPUT_COLLECTOR.replace('"/home/user/outputs"', JSON.stringify(outputs));
}

function runCollector(root: string) {
  const script = collectorFor(join(root, "outputs"));
  return Bun.spawnSync(["bash", "-c", script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
}

test("the real collector bounds admitted files in name order, so excluded entries never hide a deliverable", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "outputs-"));
  try {
    expect(runCollector(root).exitCode).not.toBe(0);
    const outputs = join(root, "outputs");
    mkdirSync(outputs);
    expect(parseCollectorOutput(runCollector(root).stdout.toString())).toEqual([]);
    // Excluded entries enumerated around the deliverables: subdirectories, a link, an oversized file.
    for (let i = 0; i < 128; i++) mkdirSync(join(outputs, `dir${String(i).padStart(3, "0")}`));
    symlinkSync("/etc/hostname", join(outputs, "a-link"));
    writeFileSync(join(outputs, "b-huge.bin"), "x".repeat(40000));
    for (let i = 0; i < 40; i++) writeFileSync(join(outputs, `f${String(i).padStart(2, "0")}.txt`), String(i));
    writeFileSync(join(outputs, "memo.pdf"), "document");
    const run = runCollector(root);
    expect(run.exitCode).toBe(0);
    const files = parseCollectorOutput(run.stdout.toString());
    expect(files.map((file) => file.name)).toEqual(
      Array.from({ length: 32 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`),
    );
    expect(admitOutputs(files)).toHaveLength(32);
    // Fewer files: the deliverable after every excluded entry is published.
    for (let i = 0; i < 40; i++) rmSync(join(outputs, `f${String(i).padStart(2, "0")}.txt`));
    const read = parseCollectorOutput(runCollector(root).stdout.toString());
    expect(read.map((file) => [file.name, Buffer.from(file.bytes).toString()])).toEqual([["memo.pdf", "document"]]);
    // Beyond the entry bound the read fails (the previous snapshot stays), never a partial snapshot.
    for (let i = 0; i < OUTPUT_MAX_ENTRIES; i++) writeFileSync(join(outputs, `z${i}`), "");
    expect(runCollector(root).exitCode).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real collector ignores modules in the caller's working directory and PYTHONPATH", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "outputs-"));
  try {
    mkdirSync(join(root, "outputs"));
    writeFileSync(join(root, "outputs", "memo.txt"), "document");
    const shadow = join(root, "shadow");
    mkdirSync(shadow);
    writeFileSync(join(shadow, "json.py"), "raise SystemExit('shadowed stdlib')\n");
    const run = Bun.spawnSync(["bash", "-c", collectorFor(join(root, "outputs"))], {
      cwd: shadow,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: shadow },
    });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
    const read = parseCollectorOutput(run.stdout.toString());
    expect(read.map((file) => [file.name, Buffer.from(file.bytes).toString()])).toEqual([["memo.txt", "document"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real collector refuses a symlink in a parent of the declared directory", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "outputs-"));
  try {
    const home = join(root, "real-home");
    mkdirSync(join(home, "outputs"), { recursive: true });
    writeFileSync(join(home, "outputs", "memo.txt"), "document");
    const linkedHome = join(root, "linked-home");
    symlinkSync(home, linkedHome);
    expect(runCollector(linkedHome).exitCode).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
