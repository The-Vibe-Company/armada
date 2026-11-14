import { expect, test } from "bun:test";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DockerHostJob } from "../src/docker-host-job.ts";
import { createDockerMachineExecutor } from "../src/docker-machine.ts";

test("snapshot builds mount credentials privately, publish automatic ownership labels and recover without rebuilding", async () => {
  const installationId = "11111111-1111-1111-1111-111111111111",
    hostId = "22222222-2222-4222-8222-222222222222",
    id = "33333333-3333-4333-8333-333333333333";
  const token = `ghs_${"a".repeat(40)}`;
  const job: Extract<DockerHostJob, { operation: "buildSnapshot" }> = {
    requestId: id,
    operation: "buildSnapshot",
    request: {
      sandboxId: id,
      generation: id,
      image: `ghcr.io/the-vibe-company/armada-sandbox@sha256:${"a".repeat(64)}`,
      ttlSeconds: 3600,
      expiresAt: 61000,
    },
    build: {
      armadaVersion: "2.28.0",
      id,
      ownerId: id,
      visibility: "private",
      token,
      config: {
        repos: [{ url: "https://github.com/example/project.git", branch: "main", dir: "project" }],
        init: ["exit 0", "printf built > /home/user/proof"],
      },
    },
  };
  const images = new Map<string, { Id: string; Config: { Labels: Record<string, string> } }>();
  let proofFailure: unknown;
  let builds = 0,
    directory = "";
  const executor = createDockerMachineExecutor({
    installationId,
    hostId,
    now: () => 1000,
    cli: {
      async run(argv, stdin, timeout) {
        if (argv[0] === "image" && argv[1] === "ls")
          return { exitCode: 0, stdout: [...images.values()].map((image) => image.Id).join("\n") };
        if (argv[0] === "image" && argv[1] === "inspect")
          return { exitCode: images.has(argv[2]!) ? 0 : 1, stdout: JSON.stringify([images.get(argv[2]!)]) };
        if (argv[0] !== "build") throw Error("Unexpected Docker operation");
        builds++;
        try {
          directory = argv.at(-1)!;
          expect(stdin).toBeUndefined();
          expect(argv.join(" ")).not.toContain(token);
          expect(timeout).toEqual({ timeoutMs: 60000, githubBuildToken: token });
          expect(argv).toContain("id=github,type=env,env=ARMADA_SNAPSHOT_GITHUB_TOKEN");
          expect((await lstat(directory)).mode & 0o777).toBe(0o700);
          for (const path of [
            "Dockerfile",
            "public/checkout.sh",
            "public/init-0.sh",
            "public/init-1.sh",
            "public/scan.sh",
            "public/receipt.json",
          ]) {
            expect((await lstat(join(directory, path))).mode & 0o777).toBe(0o600);
            expect(await readFile(join(directory, path), "utf8")).not.toContain(token);
          }
          const dockerfile = await readFile(join(directory, "Dockerfile"), "utf8");
          expect(dockerfile).toContain(`FROM ghcr.io/the-vibe-company/armada-sandbox@sha256:${"a".repeat(64)}\n`);
          expect(dockerfile).toContain("uid=0,gid=0,mode=0400");
          // A snapshot materializes only the selected head; the unchanged scan still checks every fetched object.
          expect(await readFile(join(directory, "public/checkout.sh"), "utf8")).toContain(
            "git clone --depth=1 --branch 'main' --single-branch https://github.com/example/project.git /home/user/project",
          );
          expect(dockerfile).toContain("python3 /opt/armada-build/supervise.py /opt/armada-build/init-0.sh");
          expect(dockerfile).not.toContain("exit 0");
          expect(dockerfile.indexOf("/opt/armada-build/init-0.sh")).toBeLessThan(
            dockerfile.indexOf("/opt/armada-build/init-1.sh"),
          );
          expect(JSON.parse(await readFile(join(directory, "public/receipt.json"), "utf8"))).toMatchObject({
            id,
            hostId,
            initSteps: 2,
            armadaVersion: "2.28.0",
            baseImage: job.request.image,
          });
          expect(dockerfile.indexOf("/opt/armada-build/init-1.sh")).toBeLessThan(
            dockerfile.indexOf("&& bash /opt/armada-build/scan.sh"),
          );
          for (const name of ["checkout.sh", "init-0.sh", "init-1.sh", "scan.sh"])
            expect(Bun.spawnSync(["bash", "-n", join(directory, "public", name)]).exitCode).toBe(0);
          const labels: Record<string, string> = {};
          for (let i = 0; i < argv.length; i++)
            if (argv[i] === "--label") {
              const pair = argv[i + 1]!;
              const at = pair.indexOf("=");
              labels[pair.slice(0, at)] = pair.slice(at + 1);
            }
          const tag = argv[argv.indexOf("--tag") + 1]!;
          images.set(tag, { Id: `sha256:${"b".repeat(64)}`, Config: { Labels: labels } });
          expect((await readdir(directory)).sort()).toEqual(["Dockerfile", "public"]);
        } catch (error) {
          proofFailure = error;
        }

        return { exitCode: 0, stdout: "" };
      },
    },
  });
  const built = await executor.buildSnapshot(job);
  if (proofFailure) throw proofFailure;
  expect(built).toBe(`sha256:${"b".repeat(64)}`);
  await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await executor.buildSnapshot(job, true)).toBe(`sha256:${"b".repeat(64)}`);
  expect(builds).toBe(1);
  const image = [...images.values()][0]!;
  image.Config.Labels["dev.armada.environment.armada-version"] = "2.27.0";
  await expect(executor.buildSnapshot(job, true)).rejects.toThrow("Docker snapshot build failed or outcome unknown.");
  image.Config.Labels["dev.armada.environment.armada-version"] = "2.28.0";
  image.Config.Labels["dev.armada.environment.owner"] = "44444444-4444-4444-8444-444444444444";
  await expect(executor.buildSnapshot(job, true)).rejects.toThrow("Docker snapshot build failed or outcome unknown.");
  expect(builds).toBe(1);
});
