import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { snapshotBaselineInstall } from "@armada/core/server";
import type { Sandbox } from "modal";
import { refusal } from "./errors.ts";
import type { Machine, RunnerDistribution } from "./ports.ts";
import { prepareRuntimeArtifact } from "./runtime-overlay.ts";

export interface DistributionOptions {
  base: string;
  apt: {
    gh: string;
    opensshServer: string;
    sudo: string;
    caCertificates: string;
    curl: string;
    unzip: string;
    python3: string;
  };
  bundle: Uint8Array;
  sha256: string;
  capabilities: RunnerDistribution["capabilities"];
  bootstrap(machine: Machine, env: Readonly<Record<string, string>>): Promise<object>;
  restoreEnv: RunnerDistribution["restoreEnv"];
  prepareSnapshot: RunnerDistribution["prepareSnapshot"];
  prepareFreshMachine?: NonNullable<RunnerDistribution["prepareFreshMachine"]>;
  captureProcessBaseline?: NonNullable<RunnerDistribution["captureProcessBaseline"]>;
  sealProcessBaseline?: NonNullable<RunnerDistribution["sealProcessBaseline"]>;
}
export function createRunnerDistribution(options: DistributionOptions): RunnerDistribution {
  if (createHash("sha256").update(options.bundle).digest("hex") !== options.sha256)
    throw refusal("invalid_request", "Distribution requires an immutable base and verified runner artifact.");
  const artifact = gzipSync(options.bundle, { level: 9 }).toString("base64");
  const artifactRuns = ["RUN mkdir -p /opt/armada && : > /opt/armada/.main.js.gz.b64"];
  for (let offset = 0; offset < artifact.length; offset += 32 * 1024) {
    artifactRuns.push(`RUN printf '%s' '${artifact.slice(offset, offset + 32 * 1024)}' >> /opt/armada/.main.js.gz.b64`);
  }
  artifactRuns.push(
    `RUN set -eu; base64 -d /opt/armada/.main.js.gz.b64 > /opt/armada/.main.js.gz; gzip -dc /opt/armada/.main.js.gz > /opt/armada/main.js.tmp; printf '%s\\n' '${options.sha256}  /opt/armada/main.js.tmp' | sha256sum -c -; chmod 644 /opt/armada/main.js.tmp; mv /opt/armada/main.js.tmp /opt/armada/main.js; rm -f /opt/armada/.main.js.gz.b64 /opt/armada/.main.js.gz`,
  );
  return {
    capabilities: options.capabilities,
    async prepareRuntime(sandbox, machine) {
      if ((machine.generation !== 1 && !machine.golden) || machine.freshStatePreparedGeneration === machine.generation)
        return;
      await prepareRuntimeArtifact(sandbox, options);
    },
    image: modalImage(options, artifactRuns),
    async start(sandbox: Sandbox, machine: Machine, env: Readonly<Record<string, string>>) {
      const bootstrap = await options.bootstrap(machine, env);
      const process = await sandbox.exec(
        [
          "/usr/bin/flock",
          "--nonblock",
          "--conflict-exit-code",
          "73",
          "/run/armada-runtime.lock",
          "/usr/bin/env",
          "-i",
          "PATH=/usr/local/bin:/usr/bin:/bin",
          "HOME=/home/user",
          "/usr/sbin/runuser",
          "-u",
          "user",
          "--",
          "/opt/armada/runtime-bun/bun",
          "/opt/armada/main.js",
        ],
        { env: {}, secrets: [], stdout: "ignore", stderr: "ignore" },
      );
      await process.stdin.writeText(JSON.stringify(bootstrap));
      await process.stdin.close();
    },
    restoreEnv: options.restoreEnv,
    prepareSnapshot: options.prepareSnapshot,
    ...(options.captureProcessBaseline ? { captureProcessBaseline: options.captureProcessBaseline } : {}),
    ...(options.sealProcessBaseline ? { sealProcessBaseline: options.sealProcessBaseline } : {}),
    ...(options.prepareFreshMachine ? { prepareFreshMachine: options.prepareFreshMachine } : {}),
  };
}

export function modalImage(options: Pick<DistributionOptions, "base" | "apt">, artifactRuns: readonly string[] = []) {
  if (!/^[A-Za-z0-9][A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(options.base))
    throw refusal("invalid_request", "Distribution requires an immutable base.");
  for (const key of ["gh", "opensshServer", "sudo", "caCertificates", "curl", "unzip", "python3"] as const) {
    const value = options.apt[key];
    if (typeof value !== "string" || !/^[a-zA-Z0-9.+:~_-]+$/.test(value))
      throw refusal("invalid_request", "Missing or invalid exact apt version lock.");
  }
  const build: RunnerDistribution["image"] = async (client) => {
    const commands = [
      `RUN ${snapshotBaselineInstall(
        {
          gh: options.apt.gh,
          "ca-certificates": options.apt.caCertificates,
          curl: options.apt.curl,
          unzip: options.apt.unzip,
          python3: options.apt.python3,
        },
        [`openssh-server=${options.apt.opensshServer}`, `sudo=${options.apt.sudo}`],
      )} && rm -f /etc/ssh/ssh_host_*`,
      `RUN npm install -g @anthropic-ai/claude-agent-sdk@0.3.322 @anthropic-ai/claude-code@2.1.322 @openai/codex@0.167.0 && npm cache clean --force`,
      "RUN useradd --create-home --shell /bin/bash --password '*' user && mkdir -p /opt/armada /home/user/repos && chown -R user:user /home/user && printf '%s\\n' 'user ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/armada-build-user && chmod 440 /etc/sudoers.d/armada-build-user && visudo -cf /etc/sudoers.d/armada-build-user",
      ...artifactRuns,
      "WORKDIR /home/user",
    ];
    if (commands.some((command) => Buffer.byteLength(command) > 48 * 1024))
      throw refusal("invalid_request", "Image build instruction exceeds the bounded shell argument budget.");
    return client.images.fromRegistry(options.base).dockerfileCommands(commands);
  };
  return build;
}
