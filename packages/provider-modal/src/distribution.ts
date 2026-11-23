import { snapshotBaselineInstall } from "@armada/core/server";
import { refusal } from "./errors.ts";
import type { RunnerDistribution } from "./ports.ts";

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
}

export function modalImage(options: Pick<DistributionOptions, "base" | "apt">) {
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
      "WORKDIR /home/user",
    ];
    if (commands.some((command) => Buffer.byteLength(command) > 48 * 1024))
      throw refusal("invalid_request", "Image build instruction exceeds the bounded shell argument budget.");
    return client.images.fromRegistry(options.base).dockerfileCommands(commands);
  };
  return build;
}
