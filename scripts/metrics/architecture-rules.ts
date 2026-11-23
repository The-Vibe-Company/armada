// Shared definitions for the measurement and the architecture ratchets (#2855, #2859).
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
export const providerAdapterExclusions = /^(?:packages\/(?:provider-[^/]+|docker-host)|scripts\/metrics)\//;
export const providerBranchPattern =
  /(?:[!=]==|\bcase\b)\s*(?:"(?:boat|modal|docker)"|'(?:boat|modal|docker)')|\bswitch\s*\(\s*provider\b/g;
