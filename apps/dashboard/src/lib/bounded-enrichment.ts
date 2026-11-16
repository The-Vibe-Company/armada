/** Keep UUID filters well below gateway URL limits. Failed chunks retain the UI's missing-value fallback. */
export async function boundedEnrichment<T>(
  name: string,
  ids: readonly string[],
  read: (ids: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const wanted = [...new Set(ids)];
  const rows: T[] = [];
  for (let from = 0; from < wanted.length; from += 50) {
    try {
      const { data, error } = await read(wanted.slice(from, from + 50));
      if (error) throw error;
      rows.push(...(data ?? []));
    } catch {
      // Do not log database errors: they can include query values or other interior metadata.
      console.error(`Dashboard enrichment failed: ${name}`);
    }
  }
  return rows;
}
