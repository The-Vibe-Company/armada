import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerHostInstallRoute } from "../src/docker-host-install.ts";

// The public route is the trust boundary: installer must pin the artifact served by this build.
test("installer publishes both build digests without credentials and refuses missing artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "host-installer-"));
  try {
    const route = createDockerHostInstallRoute(dir, "https://armada.example");
    const request = new Request("http://internal:8080/api/docker-host/install");
    expect((await route(request))?.status).toBe(503);
    await Bun.write(join(dir, "docker-host.json"), JSON.stringify({ x64: "a".repeat(64), arm64: "b".repeat(64) }));
    const response = await route(request);
    expect(response?.status).toBe(200);
    const script = await response?.text();
    expect(script).toContain("x86_64) digest=" + "a".repeat(64));
    expect(script).toContain("aarch64|arm64) digest=" + "b".repeat(64));
    expect(script).toContain("sha256sum --check --status");
    expect(script).toContain("read -rs token </dev/tty");
    expect(Bun.spawnSync(["bash", "-n"], { stdin: new TextEncoder().encode(script) }).exitCode).toBe(0);
    expect((await route(new Request(request.url, { method: "POST" })))?.status).toBe(405);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
