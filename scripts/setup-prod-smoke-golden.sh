#!/usr/bin/env bash
# Prepares the checked-out Armada repository for the production smoke golden.
# Run from the repository root after cloning or pulling the checkout that will
# be snapshotted. This deliberately reads packageManager and @playwright/test
# from the checkout instead of carrying tool versions in the golden.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

package_manager=$(jq -r '.packageManager // empty' package.json)
case "$package_manager" in
  bun@*) bun_version=${package_manager#bun@} ;;
  *)
    printf '%s\n' 'package.json must set packageManager to bun@<version>.' >&2
    exit 1
    ;;
esac

playwright_version=$(jq -r '.devDependencies["@playwright/test"] // empty' apps/dashboard/package.json)
if [[ -z "$playwright_version" || "$playwright_version" == *['^~<>*=| ']* ]]; then
  printf '%s\n' 'apps/dashboard/package.json must pin @playwright/test to an exact version.' >&2
  exit 1
fi

install_bun() {
  local bin_dir
  bin_dir="$HOME/.bun-npm/bin"
  npm install --global --prefix "$HOME/.bun-npm" "bun@$bun_version"
  export PATH="$bin_dir:$PATH"
}

if ! command -v bun >/dev/null 2>&1 || [[ "$(bun --version)" != "$bun_version" ]]; then
  install_bun
fi

if [[ "$(bun --version)" != "$bun_version" ]]; then
  printf 'Expected Bun %s, found %s.\n' "$bun_version" "$(bun --version)" >&2
  exit 1
fi

bun install --frozen-lockfile
bunx --bun --package "@playwright/test@$playwright_version" playwright install --with-deps chromium
