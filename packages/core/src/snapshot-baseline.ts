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
    `curl -fsSL --retry 3 -o git.tar.xz 'https://www.kernel.org/pub/software/scm/git/git-${GIT}.tar.xz'`,
    `printf '%s  git.tar.xz\\n' 3cd8fee86f69a949cb610fee8cd9264e6873d07fa58411f6060b3d62729ed7c5 | sha256sum -c -; tar -xJf git.tar.xz; cd git-${GIT}`,
    "make -s -j2 prefix=/usr NO_GETTEXT=YesPlease NO_TCLTK=YesPlease NO_PYTHON=YesPlease INSTALL_SYMLINKS=YesPlease install",
    "rm -rf /var/lib/apt/lists/*",
  ].join("; ");
}

const checks = {
  python3: `python3 -c 'import sys; assert sys.version_info >= (3, 11)' && /usr/bin/python3 -c 'import sys; assert sys.version_info >= (3, 11)'`,
  "python3-venv": "python3 -c 'import venv, ensurepip'",
  "python3-pip": "python3 -m pip --version",
  node: `[ "$(node --version)" = 'v${NODE}' ]`,
  npm: `[ "$(npm --version)" = '${NPM}' ]`,
  bun: `[ "$(bun --version)" = '${SNAPSHOT_BASELINE_BUN}' ]`,
  git: `[ "$(/usr/bin/git --version)" = 'git version ${GIT}' ] && [ "$(git --version)" = 'git version ${GIT}' ]`,
  gh: "gh --version",
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

export function snapshotBaselineFailure(output: string): string | undefined {
  const lines = new Set(output.split("\n").map((line) => line.replace(/^#\d+ \d+(?:\.\d+)? /, "").trim()));
  for (const tool of Object.keys(checks)) {
    if (lines.has(`${failurePrefix} ${tool}`))
      return `Snapshot baseline ${SNAPSHOT_BASELINE_VERSION} requires a working ${tool} at the declared version.`;
  }
}
