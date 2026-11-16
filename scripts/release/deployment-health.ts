/** Public routing must prove both readiness and the immutable source identity. */
export function matchesDeploymentHealth(health: unknown, version: string, commit: string): boolean {
  if (!/^[a-f0-9]{40}$/.test(commit) || !version || !health || typeof health !== "object") return false;
  const value = health as Record<string, unknown>;
  return value.ok === true && value.version === version && value.commit === commit;
}

if (import.meta.main) {
  try {
    const health: unknown = JSON.parse(await Bun.stdin.text());
    process.exit(matchesDeploymentHealth(health, process.argv[2] ?? "", process.argv[3] ?? "") ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
