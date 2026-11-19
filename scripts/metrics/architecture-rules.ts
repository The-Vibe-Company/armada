// Shared definitions for the measurement and the architecture ratchets (#2855, #2859).
export const sourceRoots = /^(?:packages|apps|scripts)\//;
export const sourceExtensions = /\.(?:[cm]?[jt]sx?|swift|py|sh|css)$/;
export const testPaths =
  /(?:^|\/)(?:__tests__|Tests|[^/]+Tests|test|tests|e2e|fixtures|__fixtures__)(?:\/|$)|\.(?:test|spec|release)\./;
export const generatedPaths =
  /(?:^|\/)(?:generated|Generated)\/|(?:^|\/)(?:database\.types\.ts|next-env\.d\.ts)$|\.generated\./;

export function isNonTestSource(path: string): boolean {
  return sourceRoots.test(path) && sourceExtensions.test(path) && !testPaths.test(path) && !generatedPaths.test(path);
}

export const nativePathExclusions = /^(?:packages\/agent-runtime|scripts\/metrics)\//;
export const nativePathPattern = /\b(?:agentPath|nativeRuntime|nativeCli|runtimeTransport)\b|["']native["']/g;
export const providerAdapterExclusions = /^(?:packages\/(?:provider-[^/]+|docker-host)|scripts\/metrics)\//;
export const providerBranchPattern =
  /(?:[!=]==|\bcase\b)\s*(?:"(?:boat|modal|docker)"|'(?:boat|modal|docker)')|\bswitch\s*\(\s*provider\b/g;
