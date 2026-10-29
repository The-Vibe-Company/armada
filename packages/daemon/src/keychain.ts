/** Host-owned secret lookup. THE-1995 supplies the OS keychain implementation.
 * Providers never read the environment, credential files or another app's tokens.
 */
export type SecretAccessor = (service: "linear", project: string) => Promise<string | null>;

export async function readLinearKey(access: SecretAccessor, project: string): Promise<string> {
  let key: string | null;
  try {
    key = await access("linear", project);
  } catch {
    throw new Error("Linear keychain lookup failed");
  }
  if (!key) throw new Error("Linear key is missing from the keychain");
  return key;
}
