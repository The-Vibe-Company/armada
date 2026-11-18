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

# The SDK installs alone, outside the monorepo: no workspace dependency, nothing but its bundle.
sdk="$tarballs/the-vibe-company-armada-sdk-$expected.tgz"
test -f "$sdk" || { echo "::error::missing $sdk"; exit 1; }
listed=$(tar -tzf "$sdk" | LC_ALL=C sort | tr '\n' ' ')
test "$listed" = "package/LICENSE package/README.md package/index.d.ts package/index.js package/package.json " \
  || { echo "::error::unexpected files in $sdk: $listed"; exit 1; }
mkdir -p "$work/sdk" && cd "$work/sdk"
echo '{ "name": "sdk-smoke", "private": true, "type": "module" }' > package.json
npm install --no-audit --no-fund --offline "$sdk"
test -z "$(jq -r '.dependencies // {} | keys[]' node_modules/@the-vibe-company/armada-sdk/package.json)"
cat > smoke.mjs <<'EOF'
import { createHmac } from "node:crypto";
import { Armada, ArmadaError, verifyWebhookSignature } from "@the-vibe-company/armada-sdk";
const seen = [];
const armada = new Armada({ token: "smoke", url: "https://armada.invalid", fetch: async (url) => {
  seen.push(new URL(String(url)).pathname);
  return Response.json({ error: { code: "outcome_unknown" } }, { status: 503 });
} });
const error = await armada.status({ id: "sandbox" }).catch((caught) => caught);
if (!(error instanceof ArmadaError) || error.code !== "outcome_unknown" || seen.length !== 1) {
  throw new Error(`unexpected SDK result ${error} for ${seen}`);
}
const body = "{}", id = "evt", timestamp = String(Math.floor(Date.now() / 1000));
const signature = `v1=${createHmac("sha256", "secret").update(`${timestamp}.${id}.${body}`).digest("hex")}`;
const headers = { "armada-webhook-id": id, "armada-webhook-timestamp": timestamp, "armada-webhook-signature": signature };
if (!(await verifyWebhookSignature({ secret: "secret", body, headers: new Headers(headers) }))) {
  throw new Error("webhook signature rejected");
}
const docker = { org: "o", provider: "docker", hostId: "h", harness: "codex", requestId: "r" };
let launchBody;
const receipt = await new Armada({ token: "smoke", url: "https://armada.invalid", fetch: async (_url, init) => {
  launchBody = init.body;
  return Response.json({ sandbox: { id: "s", provider: "docker", status: "running", hostId: "h" }, golden: null,
    ttlSeconds: 60, expiresAt: "2026-01-01T00:00:00.000Z" });
} }).launch(docker);
if (launchBody !== JSON.stringify(docker) || receipt.golden !== null || receipt.sandbox.id !== "s") {
  throw new Error(`unexpected Docker launch ${launchBody} -> ${JSON.stringify(receipt)}`);
}
EOF
node smoke.mjs
echo "SDK install: node import passed."
tsc="$root/node_modules/.bin/tsc"
test -x "$tsc" || { echo "::error::missing $tsc: run bun install --frozen-lockfile first"; exit 1; }
cat > smoke.ts <<'EOF'
import { Armada, type FailureCode } from "@the-vibe-company/armada-sdk";
const code: FailureCode = "outcome_unknown";
export const launched = new Armada({ token: code }).launch({ golden: "worker", harness: "codex" });
export async function docker(): Promise<{ golden: null; host: string; prompt: string | undefined }> {
  const receipt = await new Armada({ token: code }).launch({
    org: "o", provider: "docker", hostId: "h", harness: "codex", requestId: "r",
  });
  return { golden: receipt.golden, host: receipt.sandbox.hostId, prompt: receipt.promptId };
}
EOF
# No ambient types: the declarations must resolve on their own, with the standard DOM fetch types.
cat > tsconfig.json <<'EOF'
{ "compilerOptions": { "noEmit": true, "strict": true, "exactOptionalPropertyTypes": true, "target": "es2022",
  "module": "nodenext", "moduleResolution": "nodenext", "lib": ["es2023", "dom"], "types": [] },
  "files": ["smoke.ts"] }
EOF
"$tsc" -p tsconfig.json
echo "SDK install: TypeScript declarations passed."

echo "npm package smoke test passed for $target."
