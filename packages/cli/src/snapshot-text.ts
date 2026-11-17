/** Legacy API identifiers stay untouched; only diagnostic prose is renamed. */
export function snapshotText(text: string): string {
  return text.replace(
    /(?<![-/\w])(Golden|golden)(s?)\b/g,
    (_, word: string, plural: string) => `${word === "Golden" ? "Snapshot" : "snapshot"}${plural}`,
  );
}
