import { expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTPUT_MAX_ENTRIES } from "@armada/core";
import { readOutputDirectory } from "../src/outputs.ts";

const names = (files: { name: string }[]) => files.map((file) => file.name);

test("the runtime output read admits regular files in name order and never lets excluded entries hide one", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-outputs-"));
  try {
    const outputs = join(root, "outputs");
    expect(await readOutputDirectory(outputs)).toEqual([]);
    // A symlinked declared directory is refused, never followed.
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), outputs);
    await expect(readOutputDirectory(outputs)).rejects.toThrow("output_directory_unreadable");
    rmSync(outputs);
    mkdirSync(outputs);
    for (let i = 0; i < 64; i++) mkdirSync(join(outputs, `dir${String(i).padStart(2, "0")}`));
    writeFileSync(join(root, "secret"), "outside");
    symlinkSync(join(root, "secret"), join(outputs, "a-link"));
    linkSync(join(root, "secret"), join(outputs, "a-hardlink"));
    writeFileSync(join(outputs, "b-huge.bin"), "x".repeat(40000));
    for (let i = 0; i < 40; i++) writeFileSync(join(outputs, `f${String(i).padStart(2, "0")}.txt`), String(i));
    expect(names(await readOutputDirectory(outputs))).toEqual(
      Array.from({ length: 32 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`),
    );
    for (let i = 0; i < 40; i++) rmSync(join(outputs, `f${String(i).padStart(2, "0")}.txt`));
    writeFileSync(join(outputs, "memo.pdf"), "document");
    const files = await readOutputDirectory(outputs);
    expect(files).toEqual([{ name: "memo.pdf", base64: Buffer.from("document").toString("base64") }]);
    // A directory beyond the entry bound is unreadable, never a partial read that drops files.
    for (let i = 0; i < OUTPUT_MAX_ENTRIES; i++) writeFileSync(join(outputs, `n${i}`), "");
    await expect(readOutputDirectory(outputs)).rejects.toThrow("output_limit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
