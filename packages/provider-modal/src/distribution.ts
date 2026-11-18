import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { snapshotBaselineInstall } from "@armada/core/server";
import type { ModalClient } from "modal";
import { withModalDispatch } from "./client.ts";
import { refusal } from "./errors.ts";
import type { Machine, RunnerDistribution } from "./ports.ts";
import { prepareRuntimeArtifact } from "./runtime-overlay.ts";

export interface DistributionOptions {
  /** Immutable OCI digest. Image must contain Debian apt and node/npm. */
  base: string;
  /** Exact Debian package versions from a pinned Debian snapshot repository in the base image. */
  apt: {
    gh: string;
    opensshServer: string;
    sudo: string;
    caCertificates: string;
    curl: string;
    unzip: string;
    python3: string;
  };
  /** Self-contained bundled runtime main.js, built by #510; no workspace imports. */
  bundle: Uint8Array;
  sha256: string;
  capabilities: RunnerDistribution["capabilities"];
  /** Bootstrap carries root,cwd,port,grant,claudeExecutable,codexExecutable,claudeEnv,codexEnv,
   * ingestUrl,optional codexAuthJson,mcp. grant.generation is String(machine.generation).
   * Resolves grants/config/credentials server-side. Must not log or persist returned JSON. */
  bootstrap(machine: Machine, env: Readonly<Record<string, string>>): Promise<object>;
  restoreEnv: RunnerDistribution["restoreEnv"];
  prepareSnapshot: RunnerDistribution["prepareSnapshot"];
  prepareFreshMachine?: NonNullable<RunnerDistribution["prepareFreshMachine"]>;
  captureProcessBaseline?: NonNullable<RunnerDistribution["captureProcessBaseline"]>;
  sealProcessBaseline?: NonNullable<RunnerDistribution["sealProcessBaseline"]>;
}
/** No bootstrap, authorization or session data enters image construction. Pinned npm packages provide
 * official native binaries. OCI + apt locks are deployment inputs, not mutable latest tags. */
export function createRunnerDistribution(options: DistributionOptions): RunnerDistribution {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(options.base) ||
    createHash("sha256").update(options.bundle).digest("hex") !== options.sha256
  )
    throw refusal("invalid_request", "Distribution requires an immutable base and verified runner artifact.");
  for (const key of ["gh", "opensshServer", "sudo", "caCertificates", "curl", "unzip", "python3"] as const) {
    const value = options.apt[key];
    if (typeof value !== "string" || !/^[a-zA-Z0-9.+:~_-]+$/.test(value))
      throw refusal("invalid_request", "Missing or invalid exact apt version lock.");
  }
  // Linux limits *each* execve argument to 128 KiB, independently of ARG_MAX.
  // Every Docker RUN becomes a shell -c argument: never inline a complete bundle in one RUN.
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
    async image(client: ModalClient) {
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
    },
    async start(sandbox, machine, env, beforeDispatch) {
      const bootstrap = await options.bootstrap(machine, env);
      await beforeDispatch?.();
      // An empty process env does not inherit caller/management credentials. Bootstrap secrets use stdin.
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
      await withModalDispatch(beforeDispatch, async () => {
        let written = false;
        try {
          await beforeDispatch?.();
          await process.stdin.writeText(JSON.stringify(bootstrap));
          written = true;
        } finally {
          // Guarded boot owns cleanup of the child if write authority is lost.
          if (written || !beforeDispatch) await process.stdin.close();
        }
      });
      // Health/readiness is verified by the injected transport before serving user operations.
    },
    restoreEnv: options.restoreEnv,
    prepareSnapshot: options.prepareSnapshot,
    ...(options.captureProcessBaseline ? { captureProcessBaseline: options.captureProcessBaseline } : {}),
    ...(options.sealProcessBaseline ? { sealProcessBaseline: options.sealProcessBaseline } : {}),
    ...(options.prepareFreshMachine ? { prepareFreshMachine: options.prepareFreshMachine } : {}),
  };
}
