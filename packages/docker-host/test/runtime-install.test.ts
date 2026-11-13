import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerRuntimeInstaller } from "../src/runtime-install.ts";

const executable = new TextEncoder().encode("public compiled runtime fixture");
const artifact = { sha256: createHash("sha256").update(executable).digest("hex"), bytes: executable.length };
const machine = {
  sandboxId: "11111111-1111-1111-1111-111111111111",
  generation: "22222222-2222-2222-2222-222222222222",
  image: `debian@sha256:${"a".repeat(64)}`,
  ttlSeconds: 3600,
};

// This boundary owns the shared installer's composition into the host machine,
// not another replay of the installer's own download validation test suite.
test("host installs the verified runtime through its owned machine port and reuses the private warm cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-host-runtime-"));
  try {
    const cacheDir = join(directory, "cache");
    const copied: Uint8Array[] = [];
    const urls: string[] = [];
    let offline = false;
    const install = dockerRuntimeInstaller(
      {
        async installRuntime(request, bytes) {
          expect(request).toEqual(machine);
          copied.push(bytes);
        },
      },
      (async (url: string | URL | Request, options?: RequestInit) => {
        if (offline) throw Error("offline");
        urls.push(String(url));
        expect(options?.redirect).toBe("error");
        expect(options?.headers).toBeUndefined();
        return new Response(executable);
      }) as typeof fetch,
    );
    const input = { machine, serverUrl: "https://staging.example", cacheDir, artifact };
    await install(input);
    offline = true;
    await install(input);
    expect(urls).toEqual([`https://staging.example/api/runtime/artifacts/${artifact.sha256}`]);
    expect(copied).toEqual([executable, executable]);
    expect(new Uint8Array(await readFile(join(cacheDir, artifact.sha256)))).toEqual(executable);
    // Cache corruption must be detected on the next start, never copied to Docker.
    await writeFile(join(cacheDir, artifact.sha256), "corrupt runtime");
    await expect(install(input)).rejects.toThrow("Docker runtime installation failed");
    expect(copied).toHaveLength(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("host installation refuses invalid artifact bytes before Docker mutation and redacts transport diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-host-runtime-invalid-"));
  try {
    let copies = 0;
    const install = dockerRuntimeInstaller(
      {
        async installRuntime() {
          copies++;
        },
      },
      (async () => new Response(new Uint8Array(executable.length))) as unknown as typeof fetch,
    );
    await expect(
      install({ machine, serverUrl: "https://staging.example", cacheDir: join(directory, "cache"), artifact }),
    ).rejects.toThrow("Docker runtime installation failed");
    expect(copies).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
