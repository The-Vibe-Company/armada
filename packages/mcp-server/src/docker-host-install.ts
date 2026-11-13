import { join } from "node:path";
import type { Route } from "./http.ts";

/** Public installer contains only build-pinned artifacts; registration is read privately on the host. */
export function createDockerHostInstallRoute(directory: string | undefined, publicUrl: string): Route {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/docker-host/install") return null;
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const publicOrigin = new URL(publicUrl);
    if (!directory || publicOrigin.protocol !== "https:") return new Response(null, { status: 404 });
    try {
      const pins = await Bun.file(join(directory, "docker-host.json")).json();
      for (const arch of ["x64", "arm64"]) {
        if (!/^[a-f0-9]{64}$/.test(pins[arch])) throw new Error("Invalid host artifact");
      }
      // URL.origin is not shell text: encode its bytes before embedding in shell.
      const origin = Buffer.from(publicOrigin.origin).toString("base64");
      return new Response(
        `#!/usr/bin/env bash
set -euo pipefail
umask 077
[ "$(uname -s)" = Linux ] || { echo 'Linux with systemd user services is required.' >&2; exit 1; }
command -v curl >/dev/null
command -v sha256sum >/dev/null
command -v systemctl >/dev/null
systemctl --user show-environment >/dev/null
if ! docker info >/dev/null 2>&1; then
  echo 'Docker must be usable by this user. Ask the administrator to configure rootless Docker or grant Docker access (equivalent to root authority).' >&2; exit 1
fi
loginctl enable-linger || {
  echo 'Ask the administrator to enable linger for this user.' >&2; exit 1;
}
[ "$(loginctl show-user "$USER" -p Linger --value)" = yes ] || {
  echo 'Enable reboot persistence with loginctl enable-linger; if denied, ask the administrator to enable linger for this user.' >&2; exit 1;
}
case "$(uname -m)" in
  x86_64) digest=${pins.x64} ;;
  aarch64|arm64) digest=${pins.arm64} ;;
  *) echo 'Unsupported host architecture.' >&2; exit 1 ;;
esac
server=$(printf '%s' '${origin}' | base64 -d)
binary="$HOME/.local/bin/armada-docker-host"
[ ! -e "$binary" ] && [ ! -L "$binary" ] || { echo 'Existing binary: uninstall or inspect it first.' >&2; exit 1; }
mkdir -p "$HOME/.local/bin"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --proto '=https' "$server/api/runtime/artifacts/$digest" -o "$tmp/host"
printf '%s  %s\\n' "$digest" "$tmp/host" | sha256sum --check --status
chmod 700 "$tmp/host"
# Read from the terminal, not the script pipe, history, argv or environment.
printf 'Registration token: ' >/dev/tty
IFS= read -rs token </dev/tty
printf '\\n' >/dev/tty
install -m 700 "$tmp/host" "$binary"
printf '%s\\n' "$token" | "$binary" install --server "$server"
unset token
echo 'Installed. Use ~/.local/bin/armada-docker-host status to inspect the service.'
`,
        {
          headers: {
            "content-type": "text/x-shellscript",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        },
      );
    } catch {
      return new Response(null, { status: 503 });
    }
  };
}
