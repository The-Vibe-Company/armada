import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { downloadOfficialHost } from "../src/official-release.ts";

test.each(["verified", "wrong version", "wrong checksum"])(
  "automatic update stages only a pinned official artifact: %s",
  async (mode) => {
    const bytes = "official executable";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const requested: string[] = [];
    const request = (async (input: string, init: RequestInit) => {
      requested.push(input);
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      expect(init.headers).toBeUndefined();
      return requested.length === 1
        ? Response.json({ version: mode === "wrong version" ? "8.0.0" : "9.0.0", x64: sha256 })
        : new Response(mode === "wrong checksum" ? "modified executable" : bytes);
    }) as typeof fetch;
    let attempts = 0;
    const download = downloadOfficialHost(
      "9.0.0",
      "x64",
      async () => {
        attempts++;
      },
      request,
    );
    if (mode === "verified") expect((await download).toString()).toBe(bytes);
    else await expect(download).rejects.toThrow(mode === "wrong checksum" ? "checksum" : "target");
    expect(attempts).toBe(mode === "wrong version" ? 0 : 1);
    const origin = "https://armada-mcp-production.up.railway.app";
    expect(requested).toEqual([
      `${origin}/api/docker-host/install.json`,
      ...(mode === "wrong version" ? [] : [`${origin}/api/runtime/artifacts/${sha256}`]),
    ]);
  },
);
