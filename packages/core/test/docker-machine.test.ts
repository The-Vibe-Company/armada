import { describe, expect, test } from "bun:test";
import { createDockerMachineExecutor, type DockerMachineRequest } from "../src/docker-machine.ts";

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
  const calls: { argv: readonly string[]; stdin: string | undefined }[] = [];
  let time = 1000;
  let failCommand = "";
  let retainRemoved = false;
  const cli = {
    async run(argv: readonly string[], stdin?: string) {
      calls.push({ argv, stdin });
      const [kind, action] = argv;
      if (`${kind} ${action}` === failCommand) return { exitCode: 1, stdout: "SECRET Docker diagnostic" };
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
    setTime: (v: number) => {
      time = v;
    },
    fail: (v: string) => {
      failCommand = v;
    },
    retainRemoved: () => {
      retainRemoved = true;
    },
  };
}

describe("Docker machine executor", () => {
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
    { sandboxId: "--privileged" },
    { generation: "../other" },
    { ttlSeconds: 0 },
    { ttlSeconds: 86401 },
    { ttlSeconds: 1.5 },
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
