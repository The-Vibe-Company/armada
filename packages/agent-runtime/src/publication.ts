/** Architectures requestable by current Boat goldens, Modal apps and verified Docker hosts. */
export const publishedRuntimeArchitectures = ["x64"] as const;

export function requirePublishedRuntimeArchitecture(architecture: string): void {
  if (!publishedRuntimeArchitectures.some((published) => published === architecture))
    throw Error(`Runtime artifacts are not published for architecture: ${architecture}`);
}
