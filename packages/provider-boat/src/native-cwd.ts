import type { ExecRequest } from "@armada/core";

export const NATIVE_HARNESS_PATHS = {
  codex: "/usr/local/bin/codex",
  claude: "/usr/local/bin/claude",
} as const;

type NativeHarness = keyof typeof NATIVE_HARNESS_PATHS;

/**
 * Installs Boat-image wrappers for the root-owned native harness entrypoints. The original image
 * executable is moved aside exactly once; subsequent installs replace only Armada's wrapper.
 */
export async function installNativeCwdWrapper(
  exec: (request: ExecRequest) => Promise<void>,
  sandboxId: string,
  harness: NativeHarness,
  cwd: string,
  argv: readonly string[] = [],
): Promise<void> {
  const path = NATIVE_HARNESS_PATHS[harness];
  const command = nativeCwdCommand(path, harness, cwd, argv);
  await exec({
    sandboxId,
    timeoutSeconds: 60,
    command: nativeCwdInstallScript(path, command),
  });
}

/** Builds the VM wrapper command and always invokes the preserved image executable directly. */
export function nativeCwdCommand(
  path: string,
  harness: NativeHarness,
  cwd: string,
  argv: readonly string[] = [],
): string {
  const safeArgv = harness === "codex" ? stripCodexCwdOverrides(argv) : [...argv];
  return `cd -- ${quote(cwd)} && exec ${quote(`${path}.armada-original`)}${safeArgv.map((arg) => ` ${quote(arg)}`).join("")}`;
}

function stripCodexCwdOverrides(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") return [...result, "--", ...argv.slice(index + 1)];
    if (arg === "-C" || arg === "--cd") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--cd=")) continue;
    result.push(arg);
  }
  return result;
}

/** The command runs only inside a Boat sandbox, through its existing VM exec primitive. */
export function nativeCwdInstallScript(path: string, command: string): string {
  const payload = nativeCwdInstallPayload(path, command);
  return `if [ "$(id -u)" -eq 0 ]; then bash -c ${quote(payload)}; else exec sudo -n bash -c ${quote(payload)}; fi`;
}

function nativeCwdInstallPayload(path: string, command: string): string {
  const original = `${path}.armada-original`;
  const wrapper = `${path}.armada-wrapper`;
  return [
    "set -eu",
    `test -L ${quote(path)} || { echo 'native harness is unavailable' >&2; exit 1; }`,
    `test -x ${quote(path)} || { echo 'native harness is unavailable' >&2; exit 1; }`,
    `if [ ! -e ${quote(original)} ]; then mv -- ${quote(path)} ${quote(original)}; fi`,
    `test -x ${quote(original)} || { echo 'native harness original is unavailable' >&2; exit 1; }`,
    `tmp=$(mktemp ${quote(`${wrapper}.XXXXXX`)})`,
    `printf '%s\\n' '#!/bin/sh' ${quote(`exec /bin/sh -c ${quote(command)} -- "$@"`)} > "$tmp"`,
    'chmod 755 "$tmp"',
    `mv -f -- "$tmp" ${quote(wrapper)}`,
    `ln -sfn ${quote(wrapper)} ${quote(path)}`,
  ].join("; ");
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
