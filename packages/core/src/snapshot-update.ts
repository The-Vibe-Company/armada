/** Offer only a proven newer stable server release; unknown/historical versions stay unknown. */
export function snapshotUpdateAvailable(builtOnVersion: string | null, currentVersion: string | null): boolean {
  const parse = (value: string | null) =>
    value && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value) ? value.split(".").map(BigInt) : null;
  const old = parse(builtOnVersion),
    current = parse(currentVersion);
  if (!old || !current) return false;
  for (let index = 0; index < 3; index++) {
    if (current[index] !== old[index]) return current[index]! > old[index]!;
  }
  return false;
}
