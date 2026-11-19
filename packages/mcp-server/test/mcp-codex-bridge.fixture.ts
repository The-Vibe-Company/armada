import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeCwdCommand, nativeCwdInstallScript } from "../../provider-boat/src/native-cwd.ts";

export async function installEnvironment(home: string) {
  const bin = join(home, "fixture-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "sudo"),
    `#!/bin/sh
set -eu
[ "$#" -eq 4 ] && [ "$1" = -n ] && [ "$2" = bash ] && [ "$3" = -c ] || exit 97
case "$4" in *"$ARMADA_NATIVE_TEST_ROOT"*) ;; *) exit 98 ;; esac
exec /bin/bash -c "$4"
`,
    { mode: 0o755 },
  );
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home,
    ARMADA_NATIVE_TEST_ROOT: home,
  };
}

export async function installProtocolWrapper(path: string, install: (script: string) => Promise<void>) {
  if (process.platform === "linux") return install(nativeCwdInstallScript(path, nativeCwdCommand(path, "codex")));
  const original = `${path}.armada-original`;
  try {
    await lstat(original);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await rename(path, original);
  }
  await rm(path, { force: true });
  await writeFile(path, `#!/bin/sh\n${nativeCwdCommand(path, "codex")}\n`, { mode: 0o755 });
}
