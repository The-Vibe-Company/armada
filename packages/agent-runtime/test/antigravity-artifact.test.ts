import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAntigravityArchive } from "../src/antigravity-build.ts";
import { prepareAntigravity } from "../src/antigravity-install.ts";

const pin = (bytes: Uint8Array) => ({
  bytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

test("build verification rejects both truncated bytes and same-length corruption", () => {
  const archive = pin(Buffer.from("archive"));
  expect(() => verifyAntigravityArchive(Buffer.from("archive"), archive)).not.toThrow();
  expect(() => verifyAntigravityArchive(Buffer.from("short"), archive)).toThrow("length mismatch");
  expect(() => verifyAntigravityArchive(Buffer.from("corrupt"), archive)).toThrow("digest mismatch");
});

test("preparation extracts a verified executable, reuses it offline and refuses same-size tampering", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "antigravity-"));
  try {
    const executable = Buffer.from("trusted");
    const archive = await new Bun.Archive({ antigravity: executable }, { compress: "gzip" }).bytes();
    const input = {
      cacheDir,
      serverUrl: "https://armada.example",
      pin: { archive: pin(archive), executable: pin(executable) },
    };
    const path = await prepareAntigravity(input, async (url) => {
      expect(url.pathname).toBe(`/api/runtime/artifacts/${input.pin.archive.sha256}`);
      return new Response(archive);
    });
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

test("preparation verifies a pre-filled executable before using it", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "antigravity-"));
  try {
    const candidate = join(cacheDir, "antigravity");
    const trusted = Buffer.from("prefill");
    await Bun.write(candidate, trusted);
    await chmod(candidate, 0o755);
    const input = {
      cacheDir,
      candidate,
      serverUrl: "https://armada.example",
      pin: { archive: pin(Buffer.from("unused")), executable: pin(trusted) },
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
