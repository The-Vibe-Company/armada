#!/usr/bin/env bash
# Installs packed npm tarballs the way users do and runs `armada` from each install.
#
#   scripts/npm-smoke.sh <tarball-dir> [<target>]
#
# <tarball-dir> holds the `npm pack` output of scripts/npm.ts: the main package and the
# platform package of <target> (default linux-x64). The platform tarball is passed explicitly
# because, before publication, the registry has no platform package to resolve.
set -euo pipefail

tarballs=$(cd "$1" && pwd)
target=${2:-linux-x64}
root=$(cd "$(dirname "$0")/.." && pwd)
expected=$(jq -r .version "$root/packages/core/package.json")
main="$tarballs/thevibecompany-armada-$expected.tgz"
platform="$tarballs/thevibecompany-armada-$target-$expected.tgz"
test -f "$main" || { echo "::error::missing $main"; exit 1; }
test -f "$platform" || { echo "::error::missing $platform"; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

check() {
  local label=$1
  shift
  local actual
  actual=$("$@" --version)
  echo "$label: armada --version = $actual"
  test "$actual" = "$expected"
  "$@" --help | grep -q "^armada $expected: launch coding agents"
}

# The main tarball holds only the launcher, its manifest, the README and the license.
listed=$(tar -tzf "$main" | LC_ALL=C sort | tr '\n' ' ')
test "$listed" = "package/LICENSE package/README.md package/bin/armada.cjs package/package.json " \
  || { echo "::error::unexpected files in $main: $listed"; exit 1; }

mkdir -p "$work/npm" && cd "$work/npm"
npm init -y > /dev/null
npm install --no-audit --no-fund "$platform" "$main"
check "npm install, npx" npx --no-install armada

npm install --global --prefix "$work/global" --no-audit --no-fund "$platform" "$main"
check "npm install --global" "$work/global/bin/armada"

if command -v bun > /dev/null; then
  mkdir -p "$work/bun" && cd "$work/bun"
  echo '{ "name": "smoke", "private": true }' > package.json
  bun add "$platform" "$main"
  check "bun add, bun x" bun x armada
fi

echo "npm package smoke test passed for $target."
