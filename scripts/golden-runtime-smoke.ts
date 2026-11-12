import helperDigests from "../packages/core/helper/digests.json";

/** Read installed bytes; never repair a stale golden or execute downloaded binaries. */
export const helperProbe = String.raw`(
  set -eu
  case "$(uname -m)" in
    x86_64) hash=${helperDigests.x86_64} ;;
    aarch64|arm64) hash=${helperDigests.aarch64} ;;
    *) exit 1 ;;
  esac
  p=/home/user/.local/share/armada/helper/0.1.0/armada-helper
  printf '%s  %s\n' "$hash" "$p" | sha256sum --check --status
  cmp -s "$p" "$(command -v armada-helper)"
  test "$("$p")" = '{"version":"0.1.0","protocol":1,"capabilities":["diagnose"]}'
) >/dev/null 2>&1`;

/** The release archive pin is the shipped golden bootstrap's integrity contract. */
export const skillpackProbe = String.raw`(
  set -eu
  case "$(uname -m)" in
    x86_64) target=linux_amd64; hash=523a6f2d18a18e252ddcfd687c1668335d567b1f1f83b5ebb0849c19b701e916 ;;
    aarch64|arm64) target=linux_arm64; hash=b1a42ad81013871aa670f772e3d8d3e17c6f25a76af45bf361394b3726fbe54d ;;
    *) exit 1 ;;
  esac
  tmp=$(mktemp -d)
  trap 'rm -rf -- "$tmp"' EXIT
  curl --fail --silent --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 40 \
    "https://github.com/The-Vibe-Company/skillpack/releases/download/runtime-v0.3.5/skillpack-runtime_0.3.5_$target.tar.gz" -o "$tmp/archive"
  printf '%s  %s\n' "$hash" "$tmp/archive" | sha256sum --check --status
  mkdir "$tmp/stage"
  tar -xzf "$tmp/archive" -C "$tmp/stage" --no-same-owner
  dest=/home/user/.local/share/armada/skillpack/0.3.5
  cmp -s "$tmp/stage/skillpack" "$dest/skillpack"
  cmp -s "$tmp/stage/skillpack-runtime" "$dest/skillpack-runtime"
  cmp -s "$dest/skillpack" "$(command -v skillpack)"
  test "$("$dest/skillpack" --version)" = 'skillpack 0.3.5'
  test "$("$dest/skillpack-runtime" --version)" = 'skillpack-runtime 0.3.5'
) >/dev/null 2>&1`;
