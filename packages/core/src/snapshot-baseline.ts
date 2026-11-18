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
  "libexpat1-dev",
  "zlib1g-dev",
] as const;

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
    "apt-get update",
    `apt-get install -y --no-install-recommends ${apt}`,
    'work=$(mktemp -d); trap \'rm -rf -- "$work"\' EXIT; cd "$work"',
    'case "$(uname -m)" in x86_64) arch=x64; node_sha=88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a ;; aarch64|arm64) arch=arm64; node_sha=e9e1930fd321a470e29bb68f30318bf58e3ecb4acb4f1533fb19c58328a091fe ;; *) echo "Snapshot baseline: unsupported Node architecture" >&2; exit 1 ;; esac',
    `curl -fsSL --retry 3 -o node.tar.xz "https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-$arch.tar.xz"`,
    `printf '%s  node.tar.xz\\n' "$node_sha" | sha256sum -c -; tar -xJf node.tar.xz --strip-components=1 -C /usr/local`,
    `npm install -g --force --no-audit --no-fund bun@${SNAPSHOT_BASELINE_BUN}; npm cache clean --force`,
    "install -d -m 755 /opt/armada/runtime-bun",
    "install -m 555 /usr/local/lib/node_modules/bun/bin/bun.exe /opt/armada/runtime-bun/bun",
    `curl -fsSL --retry 3 -o git.tar.xz 'https://www.kernel.org/pub/software/scm/git/git-${GIT}.tar.xz'`,
    `printf '%s  git.tar.xz\\n' 3cd8fee86f69a949cb610fee8cd9264e6873d07fa58411f6060b3d62729ed7c5 | sha256sum -c -; tar -xJf git.tar.xz; cd git-${GIT}`,
    // HTTPS uses libcurl; OpenSSL would only serve imap-send, so its headers are not required.
    "make -s -j2 prefix=/usr NO_OPENSSL=YesPlease NO_GETTEXT=YesPlease NO_TCLTK=YesPlease NO_PYTHON=YesPlease INSTALL_SYMLINKS=YesPlease install",
    "rm -rf /var/lib/apt/lists/*",
  ].join("; ");
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

// Repository setup owns per-project toolchains: after it runs, a PATH node, npm,
// git or bun may be a project pin. The baseline's own fixed paths stay exact.
const afterSetupChecks: Record<keyof typeof checks, string> = {
  ...checks,
  node: "node --version",
  npm: "npm --version",
  git: `[ "$(/usr/bin/git --version)" = 'git version ${GIT}' ] && git --version`,
};

const failurePrefix = `ARMADA_BASELINE_${SNAPSHOT_BASELINE_VERSION}_FAILED`;
const verifyScript = (entries: Record<string, string>) =>
  Object.entries(entries)
    .map(([tool, check]) => `{ ${check}; } >/dev/null 2>&1 || { echo '${failurePrefix} ${tool}' >&2; exit 1; }`)
    .join("; ");
/** Verifies the provisioned image before any repository checkout or setup. */
export const snapshotBaselineVerify = verifyScript(checks);
/** Verifies what will be saved after repository setup, allowing project toolchain pins on PATH. */
export const snapshotBaselineVerifyAfterSetup = verifyScript(afterSetupChecks);

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
