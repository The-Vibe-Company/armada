/** One literal argument for a POSIX shell, including empty strings and embedded quotes. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
