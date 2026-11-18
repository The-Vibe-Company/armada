import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitOutputs,
  OUTPUT_COLLECTOR,
  OUTPUT_COLLECTOR_MANAGED_PROBE,
  OUTPUT_COLLECTOR_PROBE,
  OUTPUT_MAX_ENTRIES,
  parseCollectorOutput,
  readCollectorProbeResult,
} from "../src/sandbox-outputs.ts";
import { shellQuote } from "../src/shell-quote.ts";

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

/** Pins the guest's readers: the managed Bun, guest Buns and Python 3 are absent unless supplied,
 * so a developer machine or CI runner cannot select a different reader. */
function guest(
  script: string,
  readers: { bun?: string; python?: string; uid?: number; outputs?: string } = { bun: process.execPath },
) {
  const missing = (name: string) => `/armada-test-missing-${name}`;
  let pinned = script
    .replaceAll("/opt/armada/runtime-bun/bun", missing("managed-bun"))
    .replaceAll("/usr/bin/bun", missing("bun"))
    .replaceAll("/usr/local/bin/bun", readers.bun ? shellQuote(readers.bun) : missing("bun"))
    .replaceAll("/home/user/.bun/bin/bun", missing("bun"))
    .replaceAll("/usr/bin/python3", missing("python"))
    .replaceAll("/usr/local/bin/python3", readers.python ? shellQuote(readers.python) : missing("python"))
    .replace("/usr/bin/id -u", `printf ${readers.uid ?? 1001}`);
  if (readers.outputs) pinned = pinned.replaceAll('"/home/user/outputs"', JSON.stringify(readers.outputs));
  return pinned;
}

/** Runs the real collector against a fixture directory standing in for `/home/user/outputs`. */
function collectorFor(outputs: string, readers: { bun?: string; python?: string } = { bun: process.execPath }) {
  return guest(OUTPUT_COLLECTOR, { ...readers, outputs });
}

function runCollector(root: string, readers?: { bun?: string; python?: string }) {
  // Exercise the provider command in a guest PATH with no Python or other interpreters.
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const script = collectorFor(join(root, "outputs"), readers).replaceAll("/usr/local/bin:/usr/bin:/bin", bin);
  return Bun.spawnSync(["/bin/sh", "-c", script], { env: { PATH: bin } });
}

test.skipIf(process.platform !== "linux")("the Python-free collector bounds admitted files in name order", () => {
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

test.skipIf(process.platform !== "linux")("the collector isolates its working directory and environment", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "outputs-"));
  try {
    mkdirSync(join(root, "outputs"));
    writeFileSync(join(root, "outputs", "memo.txt"), "document");
    const shadow = join(root, "shadow");
    mkdirSync(shadow);
    writeFileSync(join(shadow, "preload.js"), "throw Error('unexpected preload');\n");
    writeFileSync(join(shadow, "bunfig.toml"), 'preload = ["./preload.js"]\n');
    const run = Bun.spawnSync(["bash", "-c", collectorFor(join(root, "outputs"))], {
      cwd: shadow,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_OPTIONS: `--require=${join(shadow, "preload.js")}` },
    });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
    const read = parseCollectorOutput(run.stdout.toString());
    expect(read.map((file) => [file.name, Buffer.from(file.bytes).toString()])).toEqual([["memo.txt", "document"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "the real collector refuses a symlink in a parent of the declared directory",
  () => {
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
  },
);

test.skipIf(process.platform !== "linux")(
  "the capability probe refuses a Bun that exits 0 without running the collector",
  () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "outputs-"));
    try {
      // An old Bun ignores `-e` after unknown flags, prints its CLI help and exits 0.
      const incompatible = join(root, "bun");
      writeFileSync(incompatible, "#!/bin/sh\necho 'Bun is a fast JavaScript runtime'\nexit 0\n", { mode: 0o755 });
      const probe = (bun: string) => {
        const script = guest(OUTPUT_COLLECTOR_PROBE, { bun });
        const run = Bun.spawnSync(["/bin/sh", "-c", script], { env: { PATH: "/usr/bin:/bin" } });
        return () => readCollectorProbeResult(run.exitCode, run.stdout.toString());
      };
      expect(probe(incompatible)).toThrow("collector_unsupported");
      expect(probe(process.execPath)()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

const python = Bun.which("python3", { PATH: "/usr/local/bin:/usr/bin:/bin" });
/** A repository-pinned Bun from before `--no-env-file`: prints its CLI help and exits 0. */
function helpPrintingBun(root: string) {
  const bun = join(root, "old-bun");
  writeFileSync(bun, "#!/bin/sh\necho 'Bun is a fast JavaScript runtime'\nexit 0\n", { mode: 0o755 });
  return bun;
}

test.skipIf(process.platform !== "linux" || !python)(
  "a sandbox from a pre-upgrade golden (no managed Bun, an old pinned Bun, Python 3) still collects",
  () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "outputs-"));
    try {
      const readers = { bun: helpPrintingBun(root), python: python! };
      const outputs = join(root, "outputs");
      mkdirSync(outputs);
      writeFileSync(join(outputs, "memo.txt"), "document");
      const probe = Bun.spawnSync(["/bin/sh", "-c", guest(OUTPUT_COLLECTOR_PROBE, readers)], {
        env: { PATH: "/usr/bin:/bin" },
      });
      expect(readCollectorProbeResult(probe.exitCode, probe.stdout.toString())).toBe(true);
      const run = runCollector(root, readers);
      expect(run.exitCode).toBe(0);
      expect(
        parseCollectorOutput(run.stdout.toString()).map((file) => [file.name, Buffer.from(file.bytes).toString()]),
      ).toEqual([["memo.txt", "document"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || !python)(
  "the Python fallback keeps the Bun reader's bounds, exclusions and exit codes",
  () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "outputs-"));
    try {
      const readers = { python: python! };
      expect(runCollector(root, readers).exitCode).toBe(4);
      const outputs = join(root, "outputs");
      mkdirSync(outputs);
      expect(parseCollectorOutput(runCollector(root, readers).stdout.toString())).toEqual([]);
      for (let i = 0; i < 8; i++) mkdirSync(join(outputs, `dir${i}`));
      symlinkSync("/etc/hostname", join(outputs, "a-link"));
      writeFileSync(join(outputs, "b-huge.bin"), "x".repeat(40000));
      writeFileSync(join(outputs, "back\\slash"), "refused name");
      for (let i = 0; i < 40; i++) writeFileSync(join(outputs, `f${String(i).padStart(2, "0")}.txt`), String(i));
      writeFileSync(join(outputs, "memo.pdf"), "document");
      const both = (r: { bun?: string; python?: string }) =>
        parseCollectorOutput(runCollector(root, r).stdout.toString()).map((file) => [
          file.name,
          Buffer.from(file.bytes).toString(),
        ]);
      const read = both(readers);
      expect(read).toEqual(both({ bun: process.execPath }));
      expect(read.map(([name]) => name)).toEqual(
        Array.from({ length: 32 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`),
      );
      for (let i = 0; i < OUTPUT_MAX_ENTRIES; i++) writeFileSync(join(outputs, `z${i}`), "");
      expect(runCollector(root, readers).exitCode).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "privileged exec without the managed Bun refuses agent-replaceable readers",
  () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "outputs-"));
    try {
      // A reader the agent owns: a privileged exec must never run it, even when it would answer.
      const agentPython = join(root, "python3");
      writeFileSync(agentPython, "#!/bin/sh\necho armada-output-collector-ready\n", { mode: 0o755 });
      const probe = Bun.spawnSync(
        ["/bin/sh", "-c", guest(OUTPUT_COLLECTOR_PROBE, { bun: process.execPath, python: agentPython, uid: 0 })],
        { env: { PATH: "/usr/bin:/bin" } },
      );
      expect(probe.exitCode).toBe(86);
      expect(() => readCollectorProbeResult(probe.exitCode, probe.stdout.toString())).toThrow("collector_unsupported");
      // The golden build proves the managed Bun alone; a fallback reader never satisfies it.
      expect(OUTPUT_COLLECTOR_MANAGED_PROBE).not.toContain("python3");
      expect(OUTPUT_COLLECTOR_MANAGED_PROBE).not.toContain("/usr/local/bin/bun");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
