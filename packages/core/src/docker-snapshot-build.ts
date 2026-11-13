import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DockerHostJob, parseDockerHostJob } from "./docker-host-job.ts";
import { DOCKER_LOCAL_IMAGE_LABELS } from "./docker-image.ts";
import type { DockerMachineCli } from "./docker-machine.ts";
import { normalizeGitHubGoldenConfig } from "./golden-config.ts";
import { goldenCheckoutScript } from "./golden-create-service.ts";
import { goldenScanScript } from "./golden-scan.ts";

/** BuildKit secret mount and shared golden checkout/init/scan. No credential file or model account. */
export async function buildDockerSnapshot(
  options: { installationId: string; hostId: string; cli: DockerMachineCli; now(): number },
  input: Extract<DockerHostJob, { operation: "buildSnapshot" }>,
  recoverOnly = false,
): Promise<string> {
  const job = parseDockerHostJob(input);
  if (job.operation !== "buildSnapshot") throw Error("Snapshot build denied.");
  const tag = `armada-snapshot-${options.installationId}-${job.build.id}`;
  const labels = {
    [DOCKER_LOCAL_IMAGE_LABELS.installation]: options.installationId,
    [DOCKER_LOCAL_IMAGE_LABELS.host]: options.hostId,
    [DOCKER_LOCAL_IMAGE_LABELS.scope]: job.build.visibility,
    [DOCKER_LOCAL_IMAGE_LABELS.owner]: job.build.ownerId,
    [DOCKER_LOCAL_IMAGE_LABELS.snapshot]: job.build.id,
    [DOCKER_LOCAL_IMAGE_LABELS.generation]: job.request.generation,
    [DOCKER_LOCAL_IMAGE_LABELS.definition]: createHash("sha256")
      .update(JSON.stringify({ image: job.request.image, config: job.build.config }))
      .digest("hex"),
  };
  let directory: string | undefined;
  const checked = async (args: string[], stdin?: string, timeoutMs?: number) => {
    const result = await options.cli.run(args, stdin, timeoutMs);
    if (result.exitCode !== 0) throw Error("Snapshot build failed.");
    return result.stdout;
  };
  const verify = async () => {
    const rows = JSON.parse(await checked(["image", "inspect", tag]));
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (
      !row ||
      !/^sha256:[0-9a-f]{64}$/.test(row.Id) ||
      Object.entries(labels).some(([key, value]) => row.Config?.Labels?.[key] !== value)
    )
      throw Error("Snapshot build denied.");
    return row.Id as string;
  };
  try {
    const existing = await checked([
      "image",
      "ls",
      "--no-trunc",
      "--filter",
      `reference=${tag}`,
      "--format",
      "{{.ID}}",
    ]);
    if (existing.trim()) return await verify();
    if (recoverOnly) throw Error("Snapshot build outcome unknown.");
    const remaining = (job.request.expiresAt ?? 0) - options.now();
    if (remaining <= 0) throw Error("Snapshot build expired.");
    directory = await mkdtemp(join(tmpdir(), "armada-snapshot-"));
    await mkdir(join(directory, "public"), { mode: 0o700 });
    const config = normalizeGitHubGoldenConfig(job.build.config);
    await writeFile(
      join(directory, "public", "checkout.sh"),
      `set +x\nset -euo pipefail\nexport ARMADA_GIT_TOKEN="$(cat /run/secrets/github)"\n${goldenCheckoutScript(config.repos)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    for (const [index, command] of config.init.entries())
      await writeFile(join(directory, "public", `init-${index}.sh`), `set +x\nset -euo pipefail\n${command}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    await writeFile(join(directory, "public", "scan.sh"), goldenScanScript(["/opt/armada-build"]), {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(
      join(directory, "public", "receipt.json"),
      JSON.stringify({
        id: job.build.id,
        hostId: options.hostId,
        installationId: options.installationId,
        ownerId: job.build.ownerId,
        visibility: job.build.visibility,
        definitionHash: labels[DOCKER_LOCAL_IMAGE_LABELS.definition],
        initSteps: config.init.length,
      }),
      { mode: 0o600, flag: "wx" },
    );
    const initCommands = config.init
      .map(
        (_, index) =>
          `setpriv --reuid=1000 --regid=1000 --init-groups --no-new-privs bash /opt/armada-build/init-${index}.sh`,
      )
      .join(" && ");
    const directories = config.repos.map((repo) => `'/home/user/${repo.dir}'`).join(" ");
    const dockerfile = `# syntax=docker/dockerfile:1
FROM oven/bun:1.4.2 AS armada-tools
FROM ${job.request.image}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm python3 git gh ca-certificates util-linux && rm -rf /var/lib/apt/lists/*
RUN (id user >/dev/null 2>&1 || useradd --create-home --uid 1000 user) && mkdir -p /home/user && chown 1000:1000 /home/user
COPY --from=armada-tools /usr/local/bin/bun /usr/local/bin/bun
ENV HOME=/home/user
WORKDIR /home/user
COPY public/ /opt/armada-build/
RUN chmod 0755 /opt/armada-build && chmod 0444 /opt/armada-build/*
ARG ARMADA_SNAPSHOT_BUILD_ID
RUN --mount=type=secret,id=github,uid=0,gid=0,mode=0400,required=true test -n "$ARMADA_SNAPSHOT_BUILD_ID" && bash /opt/armada-build/checkout.sh && chown -h -R -P -- user:user ${directories} ${initCommands ? `&& ${initCommands}` : ""} && test ! -e /home/user/armada-runtime && test ! -L /home/user/armada-runtime && bash /opt/armada-build/scan.sh
USER 1000:1000
`;
    await writeFile(join(directory, "Dockerfile"), dockerfile, { mode: 0o600, flag: "wx" });
    await checked(
      [
        "build",
        "--quiet",
        "--tag",
        tag,
        "--secret",
        "id=github,src=/dev/stdin",
        "--build-arg",
        `ARMADA_SNAPSHOT_BUILD_ID=${job.requestId}`,
        ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
        directory,
      ],
      job.build.token,
      Math.min(3600000, remaining),
    );
    return await verify();
  } catch {
    throw Error("Docker snapshot build failed or outcome unknown.");
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
