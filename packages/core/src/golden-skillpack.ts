/** Pinned native binaries only. Network failure is soft; integrity/self-test failure is not. */
export const GOLDEN_SKILLPACK_SETUP = String.raw`armada_phase=skillpack
(
  tmp=$(mktemp -d)
  trap 'rm -rf -- "$tmp"' EXIT
  case "$(uname -m)" in
    x86_64) target=linux_amd64; hash=523a6f2d18a18e252ddcfd687c1668335d567b1f1f83b5ebb0849c19b701e916 ;;
    aarch64|arm64) target=linux_arm64; hash=b1a42ad81013871aa670f772e3d8d3e17c6f25a76af45bf361394b3726fbe54d ;;
    *) printf 'ARMADA_BUILD_FAILURE skillpack 98\n' >&2; exit 98 ;;
  esac
  if ! curl --fail --silent --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 120 "https://github.com/The-Vibe-Company/skillpack/releases/download/runtime-v0.3.5/skillpack-runtime_0.3.5_$target.tar.gz" -o "$tmp/archive"; then
    printf 'ARMADA_BUILD_WARNING skillpack download_unavailable\n' >&2; exit 0
  fi
  integrity_failure() { printf 'ARMADA_BUILD_FAILURE skillpack 98\n' >&2; exit 98; }
  printf '%s  %s\n' "$hash" "$tmp/archive" | sha256sum --check --status || integrity_failure
  mkdir "$tmp/stage"
  tar -xzf "$tmp/archive" -C "$tmp/stage" --no-same-owner || integrity_failure
  [ "$("$tmp/stage/skillpack" --version 2>/dev/null)" = 'skillpack 0.3.5' ] || integrity_failure
  [ "$("$tmp/stage/skillpack-runtime" --version 2>/dev/null)" = 'skillpack-runtime 0.3.5' ] || integrity_failure
  "$tmp/stage/skillpack" --help >/dev/null 2>&1 || integrity_failure
  dest="$HOME/.local/share/armada/skillpack/0.3.5"
  for dir in "$HOME/.local" "$HOME/.local/bin" "$HOME/.local/share" "$HOME/.local/share/armada" "$HOME/.local/share/armada/skillpack" "$dest"; do
    [ ! -L "$dir" ] || integrity_failure
    mkdir -p "$dir"
  done
  install -m 755 "$tmp/stage/skillpack" "$tmp/stage/skillpack-runtime" "$dest/"
  ln -sf "$dest/skillpack" "$HOME/.local/bin/skillpack"
  if [ "$(id -u)" -eq 0 ] || [ -w /usr/local/bin ]; then
    ln -sf "$HOME/.local/bin/skillpack" /usr/local/bin/skillpack
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n ln -sf "$HOME/.local/bin/skillpack" /usr/local/bin/skillpack
  else
    printf 'ARMADA_BUILD_WARNING skillpack user_local_only\n' >&2
  fi
)`;
