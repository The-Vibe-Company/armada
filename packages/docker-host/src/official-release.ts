import { createHash } from "node:crypto";
import { stableDockerHostVersion } from "../../core/src/docker-host-upgrade.ts";

// The standalone installer uses these same production release routes. A
// registered server can select a version but cannot supply an origin or digest.
const origin = "https://armada-mcp-production.up.railway.app";

export async function downloadOfficialHost(
  version: string,
  arch: string,
  begin: () => Promise<void>,
  request: typeof fetch = fetch,
): Promise<Buffer> {
  if (!stableDockerHostVersion(version) || (arch !== "x64" && arch !== "arm64"))
    throw new Error("Unsupported Docker host release");
  async function download(path: string, limit: number) {
    const response = await request(origin + path, {
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || !response.body || response.redirected) throw new Error("Docker host release unavailable");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error("Docker host release download exceeds its size limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  const pins = JSON.parse((await download("/api/docker-host/install.json", 4096)).toString("utf8"));
  const digest: unknown = pins?.[arch];
  if (pins?.version !== version || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
    throw new Error("Docker host release manifest does not match the target");
  await begin();
  const binary = await download(`/api/runtime/artifacts/${digest}`, 256 * 1024 * 1024);
  if (createHash("sha256").update(binary).digest("hex") !== digest)
    throw new Error("Docker host release checksum mismatch");
  return binary;
}
