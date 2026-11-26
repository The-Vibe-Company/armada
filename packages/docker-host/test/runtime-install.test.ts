import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerRuntimeInstaller, dockerRuntimeStarter } from "../src/runtime-install.ts";

const executable = new TextEncoder().encode("public compiled runtime fixture");
const artifact = { sha256: createHash("sha256").update(executable).digest("hex"), bytes: executable.length };
const machine = {
  sandboxId: "11111111-1111-1111-1111-111111111111",
  generation: "22222222-2222-2222-2222-222222222222",
  image: `debian@sha256:${"a".repeat(64)}`,
  ttlSeconds: 3600,
};

test("host installs the verified runtime through its owned machine port and reads the warm cache once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-host-runtime-"));
  try {
    const cacheDir = join(directory, "cache");
    const target = join(cacheDir, artifact.sha256);
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
    const openSpy = spyOn(fs, "open");
    const bunFileSpy = spyOn(Bun, "file");
    let targetReads = 0;
    try {
      await install(input);
      targetReads =
        openSpy.mock.calls.filter(([path]) => String(path) === target).length +
        bunFileSpy.mock.calls.filter(([path]) => String(path) === target).length;
    } finally {
      openSpy.mockRestore();
      bunFileSpy.mockRestore();
    }
    expect(targetReads).toBe(1);
    expect(urls).toEqual([`https://staging.example/api/runtime/artifacts/${artifact.sha256}`]);
    expect(copied).toEqual([executable, executable]);
    expect(new Uint8Array(await readFile(target))).toEqual(executable);
    await expect(install({ ...input, serverUrl: "http://staging.example" })).rejects.toThrow(
      "Docker runtime installation failed",
    );
    await writeFile(target, "corrupt runtime");
    await expect(install(input)).rejects.toThrow("Docker runtime installation failed");
    await rm(target);
    await symlink(join(directory, "elsewhere"), target);
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

test("runtime starter delivers only enrolment on private stdin and detaches runtime output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-host-runtime-start-"));
  try {
    const token = "armada_enrol_" + "b".repeat(64);
    const events: string[] = [];
    const fakeBinary = join(directory, "runtime");
    await writeFile(fakeBinary, "#!/bin/sh\nexec sha256sum >&3\n", { mode: 0o700 });
    const start = dockerRuntimeStarter(
      {
        async installRuntime(target, bytes) {
          expect(target).toEqual(machine);
          expect(bytes).toEqual(executable);
          events.push("install");
        },
        async bootstrap(target, input) {
          expect(target).toEqual(machine);
          events.push("start");
          expect(JSON.parse(input.stdin)).toEqual({ serverUrl: "https://staging.example", enrolmentToken: token });
          expect(JSON.stringify(input.command).includes(token)).toBe(false);
          const program = input.command[0];
          if (!program) throw new Error("Missing bootstrap program");
          const result = spawnSync(
            "/bin/sh",
            ["-c", 'exec 3>&1; exec "$@"', "observe-runtime", program, ...input.command.slice(1, -1), fakeBinary],
            {
              input: input.stdin,
              timeout: 5000,
            },
          );
          expect(result.status).toBe(0);
          expect(result.stderr.toString()).toBe("");
          expect(result.stdout.toString().trim()).toBe(createHash("sha256").update(input.stdin).digest("hex") + "  -");
        },
      },
      {
        serverUrl: "https://staging.example",
        cacheDir: join(directory, "cache"),
        warmSharedArtifacts: (runtime) => {
          events.push(`warm:${runtime}`);
          return new Promise(() => {});
        },
      },
      (async () => new Response(executable)) as unknown as typeof fetch,
    );
    await start(machine, { serverUrl: "https://staging.example", artifact, enrolmentToken: token });
    expect(events).toEqual([`warm:${artifact.sha256}`, "install", "start"]);
    await expect(
      start(machine, { serverUrl: "https://other.example", artifact, enrolmentToken: token }),
    ).rejects.toThrow("Docker runtime bootstrap failed");
    expect(events).toEqual([`warm:${artifact.sha256}`, "install", "start"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
