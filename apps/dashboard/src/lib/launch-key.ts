/** The form field carrying one launch submission's request key. */
export const LAUNCH_KEY_FIELD = "launch_key";

export type LaunchKey = { fingerprint: string; key: string };

/**
 * The request key of a launch submission: the same as the previous submission's while every submitted choice is the
 * same (a retry of the same form), a new one as soon as any choice changed. `entries` are the form's own fields,
 * without the key itself.
 */
export function launchKeyFor(
  previous: LaunchKey | null,
  entries: Iterable<[string, FormDataEntryValue]>,
  fresh: () => string = () => crypto.randomUUID(),
): LaunchKey {
  const fingerprint = JSON.stringify(
    [...entries]
      .filter(([name]) => name !== LAUNCH_KEY_FIELD)
      .map(([name, value]) => [name, typeof value === "string" ? value : `file:${value.name}:${value.size}`]),
  );
  return previous?.fingerprint === fingerprint ? previous : { fingerprint, key: fresh() };
}
