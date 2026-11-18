/** Legacy API identifiers stay untouched; only diagnostic prose is renamed. */
export function snapshotText(text: string): string {
  return text.replace(
    /Ref '[^\r\n]*?' was not found in [^\s]+\. Check the branch or tag and retry\.|(?<![-/\w])(Golden|golden)(s?)\b/g,
    (match, word?: string, plural?: string) =>
      word ? `${word === "Golden" ? "Snapshot" : "snapshot"}${plural ?? ""}` : match,
  );
}
