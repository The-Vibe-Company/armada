import { join } from "node:path";
import { VERSION } from "@armada/core";
import type { Route } from "./http.ts";

/** Public script contains build pins, never tokens. Only the one-use token is accepted in installer argv. */
export function createDockerHostInstallRoute(directory: string | undefined, publicUrl: string): Route {
  return async (request) => {
    const url = new URL(request.url);
    if (!["/install-host.sh", "/api/docker-host/install.json"].includes(url.pathname)) return null;
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const publicOrigin = new URL(publicUrl);
    if (!directory || publicOrigin.protocol !== "https:") return new Response(null, { status: 404 });
    try {
      const pins = await Bun.file(join(directory, "docker-host.json")).json();
      for (const arch of ["x64", "arm64"]) {
        if (!/^[a-f0-9]{64}$/.test(pins[arch])) throw new Error("Invalid host artifact");
      }
      if (url.pathname === "/api/docker-host/install.json")
        return Response.json(
          { version: VERSION, x64: pins.x64, arm64: pins.arm64 },
          { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
        );
      // URL.origin is not shell text: encode its bytes before embedding in shell.
      const origin = Buffer.from(publicOrigin.origin).toString("base64");
      return new Response(
        `#!/bin/sh
set -eu
[ "$#" -eq 2 ] && [ "$1" = --token ] || { echo 'Usage: sh -s -- --token ONE_TIME_TOKEN' >&2; exit 1; }
token=$2
set --
case "$token" in *[!a-f0-9]*|'') echo 'Invalid one-time token.' >&2; exit 1 ;; esac
[ "\${#token}" -eq 64 ] || { echo 'Invalid one-time token.' >&2; exit 1; }
umask 077
[ "$(uname -s)" = Linux ] || { echo 'Linux with systemd user services is required.' >&2; exit 1; }
for tool in curl sha256sum systemctl loginctl docker; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing $tool; install it before adding this Docker host." >&2; exit 1; }
done
systemctl --user show-environment >/dev/null 2>&1 || {
  echo 'A working systemd user session is required. Log in as the user who will run the host service.' >&2; exit 1;
}
if ! docker info >/dev/null 2>&1; then
  echo 'Docker must be usable by this user. Ask the administrator to configure rootless Docker or grant Docker access (equivalent to root authority).' >&2; exit 1
fi
loginctl enable-linger || {
  echo 'Ask the administrator to enable linger for this user.' >&2; exit 1;
}
[ "$(loginctl show-user "$(id -u)" -p Linger --value)" = yes ] || {
  echo 'Enable reboot persistence with loginctl enable-linger; if denied, ask the administrator to enable linger for this user.' >&2; exit 1;
}
case "$(uname -m)" in
  x86_64) digest=${pins.x64} ;;
  aarch64|arm64) digest=${pins.arm64} ;;
  *) echo 'Unsupported host architecture.' >&2; exit 1 ;;
esac
server=$(printf '%s' '${origin}' | base64 -d)
# The CLI and optional global install are pinned to this server release, not latest.
package='@the-vibe-company/armada@${VERSION}'
offer_cli() {
  if command -v bun >/dev/null 2>&1; then
    global_command="bun add -g $package"
  else
    global_command="npm install -g $package"
  fi
  if [ -t 1 ] && [ -r /dev/tty ] && ( : </dev/tty ) 2>/dev/null; then
    printf 'Install the armada command on this machine? [y/N] ' >/dev/tty
    answer=n
    IFS= read -r answer </dev/tty || answer=n
    if command -v bun >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
      echo 'This npm launcher needs Node for the bare armada command. With Bun only, use: bun x --bun '"$package"
    fi
    case "$answer" in
      y|Y|yes|YES)
        if command -v bun >/dev/null 2>&1; then
          bun add -g "$package" || echo "Host is installed; global CLI installation failed. Try: $global_command" >&2
        else
          npm install -g "$package" || echo "Host is installed; global CLI installation failed. Try: $global_command" >&2
        fi
        ;;
      *) echo "To install the CLI later: $global_command" ;;
    esac
  else
    echo "To install the CLI later (requires Bun or Node/npm): $global_command"
  fi
}
if command -v bun >/dev/null 2>&1; then
  printf '%s\\n' "$token" | bun x --bun "$package" host install --server "$server"
  unset token
  offer_cli
  exit 0
elif command -v npm >/dev/null 2>&1 && command -v npx >/dev/null 2>&1; then
  printf '%s\\n' "$token" | npx -y "$package" host install --server "$server"
  unset token
  offer_cli
  exit 0
fi
echo 'Bun and npm/npx are unavailable; using the pinned standalone host binary (Node is not required).'
binary="$HOME/.local/bin/armada-docker-host"
mkdir -p "$HOME/.local/bin"
tmp=$(mktemp -d "$HOME/.local/bin/.armada-host-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --proto '=https' "$server/api/runtime/artifacts/$digest" -o "$tmp/host"
printf '%s  %s\\n' "$digest" "$tmp/host" | sha256sum --check --status
chmod 700 "$tmp/host"

[ ! -L "$binary" ] || { echo 'Refusing a symbolic link at the host binary path.' >&2; exit 1; }
if [ -e "$binary" ]; then
  [ -f "$binary" ] && [ -x "$binary" ] || { echo 'The host binary path must be an executable file.' >&2; exit 1; }
  status=$("$binary" status) || {
    echo 'Could not read the existing registration. State and the new token have been preserved. Run armada-docker-host status to diagnose it.' >&2; exit 1;
  }
  printf 'Existing Docker host: %s\\n' "$status"
  case "$status" in
    *'"registered":true'*)
      "$tmp/host" upgrade --server "$server"
      if ! printf '%s\\n' "$token" | "$tmp/host" reuse-registration --server "$server"; then
        echo 'This machine is already registered. Could not look up its name; use armada host list. The unused ticket expires automatically.'
      fi
      unset token
      echo 'Keeping the existing registration. Ctrl-C stops host add waiting if the unused ticket could not be canceled.'
      case "$status" in *'"connected":true'*) echo 'connected'; offer_cli; exit 0 ;; esac
      echo 'Restarting the existing user service and waiting for it to reconnect.'
      systemctl --user restart armada-docker-host.service
      attempt=0
      while [ "$attempt" -lt 60 ]; do
        if "$binary" status | grep -q '"connected":true'; then echo 'connected'; offer_cli; exit 0; fi
        attempt=$((attempt + 1))
        sleep 1
      done
      echo 'Existing host is still offline. Registration preserved. Check journalctl --user -u armada-docker-host.service; to replace it safely, run armada-docker-host uninstall, then paste a fresh command.' >&2
      exit 1
      ;;
    *'"registered":false'*) echo 'Replacing the unregistered host binary.' ;;
    *) echo 'Unrecognized host status; registration and token preserved.' >&2; exit 1 ;;
  esac
fi
install -m 700 "$tmp/host" "$binary"
printf '%s\\n' "$token" | "$binary" install --server "$server"
unset token
attempt=0
while [ "$attempt" -lt 60 ]; do
  if "$binary" status | grep -q '"connected":true'; then echo 'connected'; offer_cli; exit 0; fi
  attempt=$((attempt + 1))
  sleep 1
done
echo 'Installed; connection pending. Inspect armada-docker-host status; do not repeat registration.' >&2
exit 1
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
