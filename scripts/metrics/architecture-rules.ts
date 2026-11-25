// Shared definitions for the measurement and the architecture ratchets (#2855, #2859, #2861).
const sourceRoots = /^(?:packages|apps|scripts)\//;
const sourceExtensions = /\.(?:[cm]?[jt]sx?|swift|py|sh|css)$/;
export const testPaths =
  /(?:^|\/)(?:__tests__|Tests|[^/]+Tests|test|tests|e2e|fixtures|__fixtures__)(?:\/|$)|\.(?:test|spec|release)\./;
const generatedPaths =
  /(?:^|\/)(?:generated|Generated)\/|(?:^|\/)(?:database\.types\.ts|next-env\.d\.ts)$|\.generated\./;

export function isNonTestSource(path: string) {
  return sourceRoots.test(path) && sourceExtensions.test(path) && !testPaths.test(path) && !generatedPaths.test(path);
}

const nativePathExclusions = /^(?:packages\/agent-runtime|scripts\/metrics)\//;
export function isNativePathSource(path: string) {
  return /\.tsx?$/.test(path) && isNonTestSource(path) && !nativePathExclusions.test(path);
}

export const nativePathPattern = /\b(?:agentPath|nativeRuntime|nativeCli|runtimeTransport)\b|["']native["']/g;
export function* scanNativePaths(path: string, content: string) {
  for (const match of content.matchAll(nativePathPattern)) {
    const start = content.lastIndexOf("\n", match.index) + 1;
    const end = content.indexOf("\n", match.index);
    const line = content.slice(start, end === -1 ? undefined : end).trim();
    if (
      path === "packages/mcp-server/src/ordinary-launch-receipts.ts" &&
      (line === 'ordinaryRoute: "native",' || line === 'modalTransportField: "runtimeTransport",')
    )
      continue;
    yield { index: match.index, text: match[0] };
  }
}

const providerAdapterExclusions = /^(?:packages\/(?:provider-[^/]+|docker-host)|scripts\/metrics)\//;
export const machineAdapterPaths = new Set([
  "packages/core/src/docker-machine.ts",
  "packages/mcp-server/src/docker-machine-adapter.ts",
  "packages/mcp-server/src/docker-machine-bindings.ts",
  "packages/mcp-server/src/docker-machine-inventory.ts",
]);
export function isProviderBranchSource(path: string) {
  return (
    /\.tsx?$/.test(path) &&
    isNonTestSource(path) &&
    !providerAdapterExclusions.test(path) &&
    !machineAdapterPaths.has(path)
  );
}
export const providerBranchPattern =
  /(?:[!=]==|\bcase\b)\s*(?:"(?:boat|modal|docker)"|'(?:boat|modal|docker)')|\bswitch\s*\(\s*provider\b/g;
