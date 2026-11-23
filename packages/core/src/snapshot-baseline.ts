import type { ExecResult } from "./provider.ts";
import { shellQuote } from "./shell-quote.ts";

export const SNAPSHOT_BASELINE_VERSION = 1;

const NODE = "22.22.2";
const NPM = "10.9.7";
const GIT = "2.52.0";
export const SNAPSHOT_BASELINE_BUN = "1.4.2";

// Debian provides the OS tools and security updates. Explicit overrides keep the
// Modal distribution's existing apt locks for packages already in its contract.
const packages = [
  "python3",
  "python3-venv",
  "python3-pip",
  "gh",
  "build-essential",
  "curl",
  "unzip",
  "jq",
  "ripgrep",
  "ca-certificates",
  "openssh-client",
  "util-linux",
  "xz-utils",
  "perl",
  "libcurl4-openssl-dev",
  "libssl-dev",
  "libexpat1-dev",
  "zlib1g-dev",
] as const;

const installFailure = "ARMADA_BASELINE_INSTALL_FAILED";

function installSteps(apt: string): readonly (readonly [string, string])[] {
  return [
    ["apt-get update", "apt-get update"],
    ["apt-get install", `apt-get install -y --no-install-recommends ${apt}`],
    ["mktemp -d", "work=$(mktemp -d)"],
    ["cd to the temporary directory", 'cd "$work"'],
    [
      "select Node archive for uname -m",
      'case "$(uname -m)" in x86_64) arch=x64; node_sha=88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a ;; aarch64|arm64) arch=arm64; node_sha=e9e1930fd321a470e29bb68f30318bf58e3ecb4acb4f1533fb19c58328a091fe ;; *) false ;; esac',
    ],
    [
      "curl (Node archive)",
      `curl -fsSL --retry 3 -o node.tar.xz "https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-$arch.tar.xz"`,
    ],
    ["sha256sum -c (Node archive)", 'echo "$node_sha  node.tar.xz" | sha256sum -c -'],
    ["tar (Node archive)", "tar -xJf node.tar.xz --strip-components=1 -C /usr/local"],
    ["npm install (Bun)", `npm install -g --force --no-audit --no-fund bun@${SNAPSHOT_BASELINE_BUN}`],
    ["npm cache clean", "npm cache clean --force"],
    ["install (Bun directory)", "install -d -m 755 /opt/armada/runtime-bun"],
    [
      "install (Bun executable)",
      "install -m 555 /usr/local/lib/node_modules/bun/bin/bun.exe /opt/armada/runtime-bun/bun",
    ],
    [
      "curl (Git archive)",
      `curl -fsSL --retry 3 -o git.tar.xz 'https://www.kernel.org/pub/software/scm/git/git-${GIT}.tar.xz'`,
    ],
    [
      "sha256sum -c (Git archive)",
      'echo "3cd8fee86f69a949cb610fee8cd9264e6873d07fa58411f6060b3d62729ed7c5  git.tar.xz" | sha256sum -c -',
    ],
    ["tar (Git archive)", "tar -xJf git.tar.xz"],
    ["cd to the Git source directory", `cd git-${GIT}`],
    [
      "make install (Git)",
      "make -s -j2 prefix=/usr NO_GETTEXT=YesPlease NO_TCLTK=YesPlease NO_PYTHON=YesPlease INSTALL_SYMLINKS=YesPlease install",
    ],
    ["rm (apt lists)", "rm -rf /var/lib/apt/lists/*"],
  ];
}

export function snapshotBaselineInstall(
  locks: Partial<Record<(typeof packages)[number], string>> = {},
  extraPackages: readonly string[] = [],
): string {
  const apt = [...packages.map((name) => (locks[name] ? `${name}=${locks[name]}` : name)), ...extraPackages]
    .map(shellQuote)
    .join(" ");
  return [
    "set -eu",
    "export PATH=/usr/local/bin:/usr/bin:/bin DEBIAN_FRONTEND=noninteractive",
    "work=",
    'trap \'if [ -n "${work:-}" ]; then rm -rf -- "$work"; fi\' EXIT',
    ...installSteps(apt).map(
      ([step, command]) =>
        `${command} || { status=$?; echo ${shellQuote(`${installFailure} ${step}`)} >&2; exit "$status"; }`,
    ),
  ].join("; ");
}

export function snapshotBaselineInstallFailure(result: ExecResult): string {
  if (result.detached) return "Snapshot baseline installation returned a detached command.";
  if (result.timedOut) return "Snapshot baseline installation timed out.";
  const steps = installSteps("").map(([step]) => step);
  const marker = result.stderr.split("\n").findLast((line) => line.startsWith(`${installFailure} `));
  const step = marker?.slice(installFailure.length + 1);
  const command = step && steps.includes(step) ? step : "builder baseline shell (bash or sudo -n bash)";
  const status = Number.isInteger(result.exitCode) ? `exited ${result.exitCode}` : "returned no exit code";
  return `Snapshot baseline installation failed: ${command} ${status}.`;
}

const checks = {
  python3: `python3 -c 'import sys; assert sys.version_info >= (3, 11)' && /usr/bin/python3 -c 'import sys; assert sys.version_info >= (3, 11)'`,
  "python3-venv": "python3 -c 'import venv, ensurepip'",
  "python3-pip": "python3 -m pip --version",
  node: `[ "$(node --version)" = 'v${NODE}' ]`,
  npm: `[ "$(npm --version)" = '${NPM}' ]`,
  // The golden recipe can select a different project Bun on PATH.
  bun: `bun --version && [ "$(/opt/armada/runtime-bun/bun --version)" = '${SNAPSHOT_BASELINE_BUN}' ]`,
  git: `[ "$(/usr/bin/git --version)" = 'git version ${GIT}' ] && [ "$(git --version)" = 'git version ${GIT}' ]`,
  gh: "/usr/bin/gh --version && gh --version",
  "build-essential": "cc --version && c++ --version && make --version && test -r /usr/include/stdio.h",
  curl: "curl --version",
  unzip: "unzip -v",
  jq: "jq --version",
  ripgrep: "rg --version",
  "ca-certificates": "test -s /etc/ssl/certs/ca-certificates.crt",
  "openssh-client": "ssh -V",
  "util-linux": "flock --version",
};

const failurePrefix = `ARMADA_BASELINE_${SNAPSHOT_BASELINE_VERSION}_FAILED`;
export const snapshotBaselineVerify = Object.entries(checks)
  .map(([tool, check]) => `{ ${check}; } >/dev/null 2>&1 || { echo '${failurePrefix} ${tool}' >&2; exit 1; }`)
  .join("; ");

export type SnapshotBaselineTool = keyof typeof checks;

export function isSnapshotBaselineTool(value: unknown): value is SnapshotBaselineTool {
  return typeof value === "string" && Object.hasOwn(checks, value);
}

export function snapshotBaselineFailure(output: string): SnapshotBaselineTool | undefined {
  for (const line of output.split("\n")) {
    const message = line.replace(/^#\d+ \d+(?:\.\d+)? /, "").trim();
    if (!message.startsWith(`${failurePrefix} `)) continue;
    const tool = message.slice(failurePrefix.length + 1);
    if (isSnapshotBaselineTool(tool)) return tool;
  }
}

export function snapshotBaselineFailureMessage(tool: SnapshotBaselineTool): string {
  return `Snapshot baseline ${SNAPSHOT_BASELINE_VERSION} requires a working ${tool} at the declared version.`;
}
