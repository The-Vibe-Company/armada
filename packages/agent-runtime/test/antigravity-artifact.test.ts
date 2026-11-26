import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { prepareAntigravity } from "../src/antigravity-install.ts";

const pin = (bytes: Uint8Array) => ({
  bytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

const url = "https://example.test/antigravity.tar.gz";

test("preparation refuses an archive with the pinned length and a different digest", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "antigravity-"));
  try {
    const input = {
      cacheDir,
      pin: { url, archive: pin(Buffer.from("archive")), executable: pin(Buffer.from("executable")) },
    };
    await expect(prepareAntigravity(input, async () => new Response("corrupt"))).rejects.toThrow(
      "runtime_artifact_digest_mismatch",
    );
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("preparation extracts a verified executable, reuses it offline and refuses same-size tampering", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "antigravity-"));
  try {
    const executable = Buffer.from("trusted");
    const archive = await new Bun.Archive({ antigravity: executable }, { compress: "gzip" }).bytes();
    const input = {
      cacheDir,
      pin: { url, archive: pin(archive), executable: pin(executable) },
    };
    const path = await prepareAntigravity(input, async () => new Response(archive));
    expect(await Bun.file(path).text()).toBe("trusted");
    await rm(join(cacheDir, "archives"), { recursive: true });
    const offline = async () => {
      throw Error("warm cache tried to download");
    };
    expect(await prepareAntigravity(input, offline)).toBe(path);
    await Bun.write(path, "corrupt");
    await expect(prepareAntigravity(input, offline)).rejects.toThrow("antigravity_executable_mismatch");
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("preparation extracts in a single pass from sharedDir without copying archives or re-reading the temp binary", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-single-pass-"));
  const cacheDir = join(root, "cache");
  const sharedDir = join(root, "shared");
  try {
    const executable = Buffer.from("trusted-single-pass");
    const archive = await new Bun.Archive({ antigravity: executable }, { compress: "gzip" }).bytes();
    const archivePin = pin(archive);
    await mkdir(sharedDir);
    await writeFile(join(sharedDir, archivePin.sha256), archive);
    const openSpy = spyOn(fs, "open");
    let path: string;
    let tempOpens: unknown[][];
    try {
      path = await prepareAntigravity(
        { cacheDir, sharedDir, pin: { url, archive: archivePin, executable: pin(executable) } },
        async () => {
          throw Error("shared cache must bypass HTTP");
        },
      );
      tempOpens = openSpy.mock.calls.filter(([target]) => String(target).includes(".antigravity-"));
    } finally {
      openSpy.mockRestore();
    }
    expect(await Bun.file(path).text()).toBe("trusted-single-pass");
    expect(await readdir(cacheDir)).toEqual([`antigravity-${pin(executable).sha256}`]);
    expect(tempOpens).toHaveLength(1);
    expect(tempOpens[0]?.[1]).toBe("wx");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preparation verifies a pre-filled executable before using it", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "antigravity-"));
  try {
    const candidate = join(cacheDir, "antigravity");
    const trusted = Buffer.from("prefill");
    await Bun.write(candidate, trusted);
    await chmod(candidate, 0o755);
    const input = {
      cacheDir,
      candidate: relative(process.cwd(), candidate),
      pin: { url, archive: pin(Buffer.from("unused")), executable: pin(trusted) },
    };
    const offline = async () => {
      throw Error("pre-filled cache tried to download");
    };
    expect(await prepareAntigravity(input, offline)).toBe(candidate);
    await Bun.write(candidate, "changed");
    await expect(prepareAntigravity(input, offline)).rejects.toThrow("antigravity_executable_mismatch");
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
