export const FAILURE_RECORD = "ARMADA_OUTPUT_COLLECTOR_FAILURE";
const managedBunDirs = ["/opt", "/opt/armada", "/opt/armada/runtime-bun"] as const;
export const MANAGED_BUN = `${managedBunDirs[2]}/bun`;

const pathFailures: Readonly<Record<string, string>> = {
  missing: "is missing or has the wrong file type",
  mode: "has unsafe permissions",
  owner: "is not root-owned",
  symlink: "is a symlink",
};

export function outputCollectorFailureDetail(line: string) {
  if (line === `${FAILURE_RECORD} ffi`) return "Bun could not load Linux glibc through FFI";
  if (line === `${FAILURE_RECORD} proc_fd`) return "the collector could not open a directory through /proc/self/fd";
  const [marker, reason, path, ...extra] = line.split(" ");
  if (
    marker === FAILURE_RECORD &&
    reason &&
    Object.hasOwn(pathFailures, reason) &&
    extra.length === 0 &&
    [...managedBunDirs, MANAGED_BUN].some((component) => component === path)
  ) {
    return `${path} ${pathFailures[reason]}`;
  }
}

export const MANAGED_BUN_PATH_CHECK = `collector_failure() { printf '${FAILURE_RECORD} %s%s\\n' "$1" "\${2:+ $2}" >&2; return 86; }
protected_path() {
  armada_path=$1
  while [ -n "$armada_path" ]; do
    [ ! -L "$armada_path" ] || { collector_failure symlink "$armada_path"; return 86; }
    metadata=$(/usr/bin/stat -c '%u %a' -- "$armada_path" 2>/dev/null) || { collector_failure missing "$armada_path"; return 86; }
    [ "\${metadata%% *}" = 0 ] || { collector_failure owner "$armada_path"; return 86; }
    armada_mode=0\${metadata#* }
    [ "$((armada_mode & 022))" = 0 ] || { collector_failure mode "$armada_path"; return 86; }
    if [ "\${2:-}" = image-user ]; then
      [ "$((armada_mode & 001))" != 0 ] || { collector_failure mode "$armada_path"; return 86; }
    fi
    armada_path=\${armada_path%/*}
  done
}
managed_bun_path() {
  protected_path ${MANAGED_BUN} "\${1:-}" || return 86
  [ -f ${MANAGED_BUN} ] || { collector_failure missing ${MANAGED_BUN}; return 86; }
  [ -x ${MANAGED_BUN} ] || collector_failure mode ${MANAGED_BUN}
}
`;

export const MANAGED_BUN_PROVISION = `${MANAGED_BUN_PATH_CHECK}
armada_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n -- "$@"; fi; }
provision_managed_bun_dirs() {
  for armada_dir in ${managedBunDirs.join(" ")}; do
    [ ! -L "$armada_dir" ] || { collector_failure symlink "$armada_dir"; return 86; }
    if [ ! -d "$armada_dir" ]; then
      armada_root /usr/bin/mkdir -- "$armada_dir" || { collector_failure missing "$armada_dir"; return 86; }
    fi
    if ! protected_path "$armada_dir" image-user 2>/dev/null || [ ! -x "$armada_dir" ]; then
      armada_root /usr/bin/chown -h root:root -- "$armada_dir" || { collector_failure owner "$armada_dir"; return 86; }
      [ ! -L "$armada_dir" ] || { collector_failure symlink "$armada_dir"; return 86; }
      armada_root /usr/bin/chmod 00755 "$armada_dir" || { collector_failure mode "$armada_dir"; return 86; }
      protected_path "$armada_dir" image-user || return 86
      [ -x "$armada_dir" ] || { collector_failure mode "$armada_dir"; return 86; }
    fi
  done
  [ ! -L ${MANAGED_BUN} ] || collector_failure symlink ${MANAGED_BUN}
}`;
