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
main="$tarballs/the-vibe-company-armada-$expected.tgz"
platform="$tarballs/the-vibe-company-armada-$target-$expected.tgz"
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

check_files() {
  local archive=$1 kind=$2
  local expected_files actual_files
  expected_files=$(jq -r --arg kind "$kind" '.[$kind][] | "package/" + .' "$root/scripts/release/npm-pack-files.json" | LC_ALL=C sort)
  actual_files=$(tar -tzf "$archive" | LC_ALL=C sort)
  diff -u <(printf '%s\n' "$expected_files") <(printf '%s\n' "$actual_files")
}

check_files "$main" cli
check_files "$platform" platform

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

# The SDK installs alone, outside the monorepo: no workspace dependency, nothing but its bundle.
sdk="$tarballs/the-vibe-company-armada-sdk-$expected.tgz"
test -f "$sdk" || { echo "::error::missing $sdk"; exit 1; }
check_files "$sdk" sdk
mkdir -p "$work/sdk" && cd "$work/sdk"
echo '{ "name": "sdk-smoke", "private": true, "type": "module" }' > package.json
npm install --no-audit --no-fund --offline "$sdk"
test -z "$(jq -r '.dependencies // {} | keys[]' node_modules/@the-vibe-company/armada-sdk/package.json)"
node --input-type=module - "$root/scripts/release/sdk-smoke.mjs" <<'EOF'
import { pathToFileURL } from "node:url";
const { smokeSdk } = await import(pathToFileURL(process.argv[2]).href);
await smokeSdk(await import("@the-vibe-company/armada-sdk"));
EOF
echo "SDK install: node import passed."
tsc="$root/node_modules/.bin/tsc"
test -x "$tsc" || { echo "::error::missing $tsc: run bun install --frozen-lockfile first"; exit 1; }
cp "$root/packages/sdk/test/npm-smoke.types.ts" smoke.ts
# No ambient types: the declarations must resolve on their own, with the standard DOM fetch types.
cat > tsconfig.json <<'EOF'
{ "compilerOptions": { "noEmit": true, "strict": true, "exactOptionalPropertyTypes": true, "target": "es2022",
  "module": "nodenext", "moduleResolution": "nodenext", "lib": ["es2023", "dom"], "types": [] },
  "files": ["smoke.ts"] }
EOF
"$tsc" -p tsconfig.json
echo "SDK install: TypeScript declarations passed."

echo "npm package smoke test passed for $target."
