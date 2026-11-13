import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCKER_LOCAL_IMAGE_LABELS } from "../src/docker-image.ts";
import {
  createDockerMachineExecutor,
  DOCKER_IMAGE_PULL_TIMEOUT_MS,
  type DockerMachineRequest,
} from "../src/docker-machine.ts";

const request: DockerMachineRequest = {
  sandboxId: "33333333-3333-3333-3333-333333333333",
  generation: "44444444-4444-4444-4444-444444444444",
  image: `debian@sha256:${"a".repeat(64)}`,
  ttlSeconds: 60,
};

// Minimal independent Docker state machine: inspect returns stored Docker-shaped records,
// not receipts or ownership decisions supplied by the executor.
function fixture() {
  const containers = new Map<string, any>();
  const volumes = new Map<string, any>();
  const calls: {
    argv: readonly string[];
    stdin: string | Uint8Array | undefined;
    options?: { timeoutMs?: number };
  }[] = [];
  const copies = new Map<string, Uint8Array>();
  let time = 1000;
  let failCommand = "";
  let retainRemoved = false;
  // Images present on the host (by reference, as `docker image inspect` reports them), and those its registry serves.
  const images = new Map<string, unknown>([[request.image, { Id: request.image }]]);
  const registry = new Set<string>();
  const cli = {
    async run(argv: readonly string[], stdin?: string | Uint8Array, options?: { timeoutMs?: number }) {
      calls.push({ argv, stdin, ...(options ? { options } : {}) });
      const [kind, action] = argv;
      if (kind === "image") {
        const image = argv.at(-1) ?? "";
        if (action === "pull" && registry.has(image)) images.set(image, { Id: image });
        return {
          exitCode: images.has(image) ? 0 : 1,
          stdout: action === "inspect" ? JSON.stringify([images.get(image)]) : "",
        };
      }
      if (`${kind} ${action}` === failCommand) return { exitCode: 1, stdout: "SECRET Docker diagnostic" };
      if (kind === "cp") {
        const [name, destination] = (argv.at(-1) ?? "").split(":");
        if (!name || !containers.get(name)?.State.Running || destination !== "/home" || !(stdin instanceof Uint8Array))
          return { exitCode: 1, stdout: "invalid copy destination or archive" };
        copies.set(name, stdin);
        return { exitCode: 0, stdout: "" };
      }
      const store = kind === "container" ? containers : volumes;
      const last = argv.at(-1)!;
      const value = (flag: string) => argv[argv.indexOf(flag) + 1]!;
      const labels: Record<string, string> = {};
      argv.forEach((arg, i) => {
        if (arg === "--label") {
          const pair = argv[i + 1]!;
          const split = pair.indexOf("=");
          labels[pair.slice(0, split)] = pair.slice(split + 1);
        }
      });
      if (action === "ls") {
        return { exitCode: 0, stdout: [...store.keys()].map((name) => JSON.stringify(name)).join("\n") };
      }
      if (action === "inspect") return { exitCode: store.has(last) ? 0 : 1, stdout: JSON.stringify([store.get(last)]) };
      if (action === "create" && kind === "volume") {
        if (!store.has(last)) store.set(last, { Name: last, Driver: "local", Options: null, Labels: labels });
      } else if (action === "create") {
        const name = value("--name");
        if (store.has(name)) return { exitCode: 1, stdout: "name already exists" };
        const mount = Object.fromEntries(
          value("--mount")
            .split(",")
            .map((part) => part.split("=")),
        );
        store.set(name, {
          Name: `/${name}`,
          Config: { Image: argv[argv.indexOf("--entrypoint") + 2], User: value("--user"), Labels: labels },
          HostConfig: { Privileged: false },
          Mounts: [{ Type: mount.type, Name: mount.src, Destination: mount.dst, RW: true }],
          State: { Status: "created", Running: false },
        });
      } else if (action === "start" || action === "stop") {
        const container = store.get(last);
        if (!container) return { exitCode: 1, stdout: "missing" };
        container.State = { Status: action === "start" ? "running" : "exited", Running: action === "start" };
      } else if (action === "rm") {
        if (!retainRemoved) store.delete(last);
      } else if (action !== "exec") throw new Error("Unexpected fake Docker operation");
      return { exitCode: 0, stdout: "" };
    },
  };
  const executor = createDockerMachineExecutor({
    installationId: "11111111-1111-1111-1111-111111111111",
    hostId: "22222222-2222-2222-2222-222222222222",
    cli,
    now: () => time,
  });
  return {
    executor,
    containers,
    volumes,
    calls,
    copies,
    images,
    setTime: (v: number) => {
      time = v;
    },
    fail: (v: string) => {
      failCommand = v;
    },
    retainRemoved: () => {
      retainRemoved = true;
    },
    registry,
    cli,
  };
}

describe("Docker machine executor", () => {
  test("fetches an image the host does not have with a pull's own bound, and names a failed fetch", async () => {
    const fresh = { ...request, image: `buildpack-deps@sha256:${"b".repeat(64)}` };
    const pulled = fixture();
    pulled.registry.add(fresh.image);
    await pulled.executor.create(fresh);
    expect(pulled.images.has(fresh.image)).toBe(true);
    const pull = pulled.calls.find((call) => call.argv[0] === "image" && call.argv[1] === "pull");
    expect(pull?.options).toEqual({ timeoutMs: DOCKER_IMAGE_PULL_TIMEOUT_MS });
    expect(pulled.containers.size).toBe(1);
    // Present images are never pulled again.
    const present = fixture();
    await present.executor.create(request);
    expect(present.calls.some((call) => call.argv[1] === "pull")).toBe(false);

    const missing = fixture();
    await expect(missing.executor.create(fresh)).rejects.toMatchObject({ code: "image_unavailable" });
    expect(missing.containers.size).toBe(0);
    const broken = fixture();
    broken.registry.add(fresh.image);
    const run = broken.cli.run;
    broken.cli.run = async (argv, stdin, options) => {
      if (argv[1] === "pull") throw new Error("killed after its bound");
      return run(argv, stdin, options);
    };
    await expect(broken.executor.create(fresh)).rejects.toMatchObject({ code: "image_unavailable" });
  });

  test("installs the fixed runtime archive with private modes and numeric workspace ownership", async () => {
    const f = fixture();
    const receipt = await f.executor.create(request);
    const executable = new Uint8Array([0, 255, 128, 10, 42]);
    await f.executor.installRuntime(request, executable);
    const archive = f.copies.get(receipt.containerName);
    if (!archive) throw new Error("Runtime archive was not copied to the owned machine");
    const directory = mkdtempSync(join(tmpdir(), "armada-runtime-tar-"));
    try {
      const listing = spawnSync("tar", ["--list", "--verbose", "--numeric-owner", "--file", "-"], { input: archive });
      expect(listing.status).toBe(0);
      expect(listing.stdout.toString().trim().split("\n")).toEqual([
        expect.stringMatching(/^drwx------ 1000\/1000\s+0 .* user\/$/),
        expect.stringMatching(/^-rwx------ 1000\/1000\s+5 .* user\/armada-runtime$/),
      ]);
      const extraction = spawnSync("tar", ["--extract", "--no-same-owner", "--file", "-", "--directory", directory], {
        input: archive,
      });
      expect(extraction.status).toBe(0);
      expect(readdirSync(directory)).toEqual(["user"]);
      expect(readdirSync(join(directory, "user"))).toEqual(["armada-runtime"]);
      expect(new Uint8Array(readFileSync(join(directory, "user/armada-runtime")))).toEqual(executable);
      expect(statSync(join(directory, "user")).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, "user/armada-runtime")).mode & 0o777).toBe(0o700);
      await f.executor.installRuntime(request, executable);
      expect(f.copies.get(receipt.containerName)).toEqual(archive);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("runtime installation refuses changed identity, expiry, stopped machines and empty artifacts before copying", async () => {
    for (const mutation of ["container-label", "volume-label", "image", "expired", "stopped", "empty"]) {
      const f = fixture();
      const receipt = await f.executor.create(request);
      const container = f.containers.get(receipt.containerName);
      if (mutation === "container-label") container.Config.Labels["dev.armada.machine.host"] = "foreign";
      if (mutation === "volume-label")
        f.volumes.get(receipt.volumeName).Labels["dev.armada.machine.generation"] = "foreign";
      if (mutation === "image") container.Config.Image = "debian:latest";
      if (mutation === "expired") f.setTime(receipt.expiresAt);
      if (mutation === "stopped") await f.executor.stop(request);
      const before = f.calls.length;
      await expect(
        f.executor.installRuntime(request, new Uint8Array(mutation === "empty" ? 0 : 1)),
      ).rejects.toMatchObject({
        code:
          mutation === "expired"
            ? "expired"
            : mutation === "stopped"
              ? "not_found"
              : mutation === "empty"
                ? "invalid_request"
                : "ownership_mismatch",
      });
      expect(f.calls.slice(before).every((c) => ["ls", "inspect"].includes(c.argv[1] ?? ""))).toBe(true);
      expect(f.copies.size).toBe(0);
    }
  });

  test("runtime copy failures expose no Docker diagnostics", async () => {
    const f = fixture();
    await f.executor.create(request);
    f.fail("cp --archive");
    await expect(f.executor.installRuntime(request, new Uint8Array([1]))).rejects.toThrow(
      "Docker machine docker_failed",
    );
    expect(f.copies.size).toBe(0);
  });

  test("creates one durable machine, retries without allocation, bootstraps privately, stops and deletes exact resources", async () => {
    const f = fixture();
    const first = await f.executor.create(request);
    f.setTime(2000);
    expect(await f.executor.create(request)).toEqual(first);
    expect(f.containers.size).toBe(1);
    expect(f.volumes.size).toBe(1);
    expect(f.calls.filter((c) => c.argv[1] === "create")).toHaveLength(2);
    const container = f.containers.get(first.containerName);
    expect(container.Config.User).toBe("1000:1000");
    expect(container.Mounts).toEqual([{ Type: "volume", Name: first.volumeName, Destination: "/home/user", RW: true }]);
    await f.executor.bootstrap(request, { command: ["/opt/armada/runtime", "dialout"], stdin: "PRIVATE_ENROLMENT" });
    expect(JSON.stringify(f.calls.map((c) => c.argv))).not.toContain("PRIVATE_ENROLMENT");
    expect(f.calls.at(-1)?.stdin).toBe("PRIVATE_ENROLMENT");
    await f.executor.stop(request);
    expect(container.State.Running).toBe(false);
    await expect(f.executor.create(request)).rejects.toMatchObject({ code: "ownership_mismatch" });
    await f.executor.delete(request);
    await f.executor.delete(request);
    expect(f.containers.size).toBe(0);
    expect(f.volumes.size).toBe(0);
  });

  test("absolute expiry survives delayed allocation and retry, stops at its deadline and permits cleanup", async () => {
    const f = fixture();
    const absolute = { ...request, expiresAt: 61000 };
    f.setTime(21000);
    f.fail("container create");
    await expect(f.executor.create(absolute)).rejects.toMatchObject({ code: "docker_failed" });
    const volume = [...f.volumes.values()][0];
    expect(volume.Labels["dev.armada.machine.created-at"]).toBe("21000");
    expect(volume.Labels["dev.armada.machine.expires-at"]).toBe("61000");
    f.setTime(31000);
    f.fail("");
    const receipt = await f.executor.create(absolute);
    expect(receipt.expiresAt).toBe(61000);
    expect(await f.executor.create(absolute)).toEqual(receipt);
    expect(f.calls.filter((c) => c.argv[0] === "volume" && c.argv[1] === "create")).toHaveLength(1);
    expect(await f.executor.stopIfExpired(absolute)).toBe(false);
    f.setTime(61000);
    await expect(f.executor.create(absolute)).rejects.toMatchObject({ code: "expired" });
    expect(await f.executor.stopIfExpired(absolute)).toBe(true);
    expect(f.containers.get(receipt.containerName).State.Running).toBe(false);
    await f.executor.stop(absolute);
    await f.executor.delete(absolute);
    expect(f.containers.size).toBe(0);
    expect(f.volumes.size).toBe(0);
  });

  test("rejects expired queued allocation but caps future absolute deadlines to the local TTL", async () => {
    for (const expiresAt of [1000, 999]) {
      const f = fixture();
      await expect(f.executor.create({ ...request, expiresAt })).rejects.toMatchObject({ code: "expired" });
      expect(f.calls.some((c) => c.argv[1] === "create")).toBe(false);
      expect(f.containers.size).toBe(0);
      expect(f.volumes.size).toBe(0);
    }
    const f = fixture();
    const absolute = { ...request, expiresAt: 62000 };
    const receipt = await f.executor.create(absolute);
    expect(receipt.expiresAt).toBe(61000);
    expect(f.volumes.get(receipt.volumeName).Labels["dev.armada.machine.absolute-expiry"]).toBe("62000");
    f.setTime(2000);
    expect(await f.executor.create(absolute)).toEqual(receipt);
    f.setTime(61000);
    expect(await f.executor.stopIfExpired(absolute)).toBe(true);
  });

  test("changed or omitted absolute deadline cannot mutate the same generation even with an identical effective cap", async () => {
    const f = fixture();
    const absolute = { ...request, expiresAt: 62000 };
    await f.executor.create(absolute);
    const before = f.calls.length;
    for (const changed of [{ ...absolute, expiresAt: 63000 }, request]) {
      for (const operation of [
        () => f.executor.create(changed),
        () => f.executor.stop(changed),
        () => f.executor.stopIfExpired(changed),
        () => f.executor.delete(changed),
        () => f.executor.bootstrap(changed, { command: ["/opt/armada/runtime"], stdin: "secret" }),
        () => f.executor.installRuntime(changed, new Uint8Array([1])),
      ]) {
        await expect(operation()).rejects.toMatchObject({ code: "ownership_mismatch" });
      }
    }
    expect(f.calls.slice(before).every((c) => ["ls", "inspect"].includes(c.argv[1] ?? ""))).toBe(true);
    expect([...f.containers.values()][0].State.Running).toBe(true);
    expect(f.volumes.size).toBe(1);
  });

  test.each(["container-label", "volume-label", "image", "bind-mount"])(
    "refuses mismatched %s before mutating any resource",
    async (mutation) => {
      const f = fixture();
      const receipt = await f.executor.create(request);
      const container = f.containers.get(receipt.containerName);
      if (mutation === "container-label") container.Config.Labels["dev.armada.machine.host"] = "foreign";
      if (mutation === "volume-label")
        f.volumes.get(receipt.volumeName).Labels["dev.armada.machine.generation"] = "foreign";
      if (mutation === "image") container.Config.Image = "debian:latest";
      if (mutation === "bind-mount")
        container.Mounts = [{ Type: "bind", Source: "/var/run/docker.sock", Destination: "/home/user", RW: true }];
      const before = f.calls.length;
      for (const operation of [
        () => f.executor.create(request),
        () => f.executor.stop(request),
        () => f.executor.delete(request),
        () => f.executor.bootstrap(request, { command: ["/opt/armada/runtime"], stdin: "secret" }),
      ]) {
        await expect(operation()).rejects.toMatchObject({ code: "ownership_mismatch" });
      }
      expect(f.calls.slice(before).every((c) => ["ls", "inspect"].includes(c.argv[1]!))).toBe(true);
      expect(f.containers.size).toBe(1);
      expect(f.volumes.size).toBe(1);
    },
  );

  test.each(["container rm", "container ls", "container inspect", "rm-keeps-container"])(
    "preserves volume when container removal is unproven: %s",
    async (failure) => {
      const f = fixture();
      await f.executor.create(request);
      if (failure === "rm-keeps-container") f.retainRemoved();
      else f.fail(failure);
      await expect(f.executor.delete(request)).rejects.toMatchObject({ code: "docker_failed" });
      expect(f.volumes.size).toBe(1);
      expect(f.calls.some((c) => c.argv[0] === "volume" && c.argv[1] === "rm")).toBe(false);
    },
  );

  test("recovers orphaned owned volume after create failure without extending TTL", async () => {
    const f = fixture();
    f.fail("container create");
    await expect(f.executor.create(request)).rejects.toMatchObject({ code: "docker_failed" });
    expect(f.volumes.size).toBe(1);
    f.setTime(2000);
    f.fail("");
    const receipt = await f.executor.create(request);
    expect(receipt.expiresAt).toBe(61000);
    expect(f.volumes.size).toBe(1);
  });

  test("host sweep stops an expired exact machine; retries cannot extend or bootstrap it", async () => {
    const f = fixture();
    const receipt = await f.executor.create(request);
    expect(await f.executor.stopIfExpired(request)).toBe(false);
    f.setTime(receipt.expiresAt);
    await expect(
      f.executor.bootstrap(request, { command: ["/opt/armada/runtime"], stdin: "secret" }),
    ).rejects.toMatchObject({ code: "expired" });
    await expect(f.executor.create(request)).rejects.toMatchObject({ code: "expired" });
    expect(await f.executor.stopIfExpired(request)).toBe(true);
    expect(f.containers.get(receipt.containerName).State.Running).toBe(false);
    expect(f.volumes.size).toBe(1);
  });

  test("ignores unrelated listed resources without inspecting or mutating them", async () => {
    const f = fixture();
    const unrelatedContainer = { Name: "/someone-else" };
    const unrelatedVolume = { Name: "someone-else-home" };
    f.containers.set("someone-else", unrelatedContainer);
    f.volumes.set("someone-else-home", unrelatedVolume);
    await f.executor.create(request);
    await f.executor.delete(request);
    expect([...f.containers.values()]).toEqual([unrelatedContainer]);
    expect([...f.volumes.values()]).toEqual([unrelatedVolume]);
    expect(
      f.calls
        .filter((call) => call.argv[1] === "inspect")
        .every((call) => !call.argv.includes("someone-else") && !call.argv.includes("someone-else-home")),
    ).toBe(true);
  });

  test.each([
    { image: "debian:latest" },
    { image: "sha256:abcdef" },
    { image: `sha256:${"A".repeat(64)}` },
    { sandboxId: "--privileged" },
    { generation: "../other" },
    { ttlSeconds: 0 },
    { ttlSeconds: 86401 },
    { ttlSeconds: 1.5 },
    { expiresAt: 0 },
    { expiresAt: -1 },
    { expiresAt: 1.5 },
    { expiresAt: Number.NaN },
    { expiresAt: Number.POSITIVE_INFINITY },
    { expiresAt: 8_640_000_000_000_001 },
  ])("rejects invalid admission before any CLI access: %j", async (change) => {
    const f = fixture();
    await expect(f.executor.create({ ...request, ...change })).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.calls).toHaveLength(0);
  });

  test("Docker diagnostics and bootstrap secrets do not escape in errors", async () => {
    const f = fixture();
    await f.executor.create(request);
    f.fail("container exec");
    await expect(
      f.executor.bootstrap(request, { command: ["/opt/armada/runtime"], stdin: "PRIVATE_ENROLMENT" }),
    ).rejects.toThrow("Docker machine docker_failed");
  });
});

test("resume starts only the retained owned stopped machine without reallocating or extending TTL", async () => {
  const f = fixture();
  const original = await f.executor.create(request);
  await f.executor.stop(request);
  f.calls.length = 0;
  await f.executor.resume(request);
  expect(f.containers.get(original.containerName).State.Running).toBe(true);
  expect(f.volumes.size).toBe(1);
  expect(f.calls.filter((call) => call.argv[1] === "create")).toHaveLength(0);
  await f.executor.stop(request);
  f.setTime(original.expiresAt);
  await expect(f.executor.resume(request)).rejects.toThrow("expired");
  await f.executor.delete(request);
  await expect(f.executor.resume(request)).rejects.toThrow("not_found");
});

test.each([
  "approved",
  "foreign-host",
  "foreign-installation",
  "private",
  "missing-approval",
  "wrong-id",
  "missing-image",
  "private-authorized",
  "private-wrong-owner",
])("local immutable image admission requires exact host org approval (%s)", async (mode) => {
  const f = fixture();
  const image = `sha256:${"b".repeat(64)}`;
  const labels: Record<string, string> = {
    [DOCKER_LOCAL_IMAGE_LABELS.installation]: "11111111-1111-1111-1111-111111111111",
    [DOCKER_LOCAL_IMAGE_LABELS.host]: "22222222-2222-2222-2222-222222222222",
    [DOCKER_LOCAL_IMAGE_LABELS.scope]: "org",
  };
  if (mode === "foreign-host") labels[DOCKER_LOCAL_IMAGE_LABELS.host] = "55555555-5555-5555-5555-555555555555";
  if (mode === "foreign-installation")
    labels[DOCKER_LOCAL_IMAGE_LABELS.installation] = "55555555-5555-5555-5555-555555555555";
  if (mode === "private" || mode.startsWith("private-")) labels[DOCKER_LOCAL_IMAGE_LABELS.scope] = "private";
  if (mode.startsWith("private-")) {
    labels[DOCKER_LOCAL_IMAGE_LABELS.owner] = request.sandboxId;
    labels[DOCKER_LOCAL_IMAGE_LABELS.snapshot] = request.sandboxId;
  }
  if (mode === "missing-approval") delete labels[DOCKER_LOCAL_IMAGE_LABELS.scope];
  if (mode !== "missing-image")
    f.images.set(image, { Id: mode === "wrong-id" ? `sha256:${"c".repeat(64)}` : image, Config: { Labels: labels } });
  const local = {
    ...request,
    image,
    ...(mode.startsWith("private-")
      ? {
          snapshot: {
            id: request.sandboxId,
            ownerId: mode === "private-wrong-owner" ? "55555555-5555-5555-5555-555555555555" : request.sandboxId,
            visibility: "private" as const,
          },
        }
      : {}),
  };
  if (mode !== "approved" && mode !== "private-authorized") {
    await expect(f.executor.create(local)).rejects.toMatchObject({
      code: mode === "missing-image" ? "docker_failed" : "ownership_mismatch",
    });
    expect(f.containers.size).toBe(0);
    expect(f.volumes.size).toBe(0);
    return;
  }
  await f.executor.create(local);
  expect([...f.containers.values()][0].Config.Image).toBe(image);
  expect(f.calls.filter((call) => call.argv[0] === "image").map((call) => call.argv)).toEqual([
    ["image", "inspect", image],
  ]);
  // Retained operations must not depend on the shared image cache remaining present.
  f.images.delete(image);
  await f.executor.stop(local);
  await f.executor.resume(local);
  await f.executor.delete(local);
  expect(f.containers.size).toBe(0);
  expect(f.volumes.size).toBe(0);
});

test("registry digest references whose repository is named sha256 do not require local-image approval", async () => {
  const f = fixture();
  const image = `sha256:base@sha256:${"a".repeat(64)}`;
  f.registry.add(image);
  await f.executor.create({ ...request, image });
  expect(f.containers.size).toBe(1);
  // Only the presence check and the fetch of a registry image (#1507), never a local-image approval inspect.
  expect(f.calls.filter((call) => call.argv[0] === "image").map((call) => call.argv)).toEqual([
    ["image", "inspect", "--format", "{{.Id}}", image],
    ["image", "pull", "--quiet", image],
  ]);
});
