/** Resume opcode first shipped in 2.28; initial bootstrap remains 2.27 compatible. */
export function dockerHostSupportsResume(value: string | null | undefined): boolean {
  const version = value?.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?$/);
  const major = Number(version?.[1]);
  const minor = Number(version?.[2]);
  return (
    !!version &&
    Number.isSafeInteger(major) &&
    Number.isSafeInteger(minor) &&
    (major > 2 || (major === 2 && minor >= 28))
  );
}
