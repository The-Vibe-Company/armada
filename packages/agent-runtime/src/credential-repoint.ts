import { readFile, rm, writeFile } from "node:fs/promises";

const authPaths = (root: string) => [`${root}/codex/auth.json`, `${root}/claude/.credentials.json`];
const strings = (value: unknown): string[] =>
  typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

/** A stopped writer was checkpointed before this new binding was committed. Never publish its surviving file as the new account. */
export async function prepareCredentialRepoint(
  root: string,
  operation: string | undefined,
  register: (values: string[]) => void,
  sanitize: () => void,
): Promise<boolean> {
  if (!operation) return false;
  let saved: { operation?: string; complete?: boolean } | undefined;
  try {
    saved = JSON.parse(await readFile(`${root}/credential-binding.json`, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (saved?.operation === operation && saved.complete === true) return false;
  for (const file of authPaths(root)) {
    try {
      const raw = await readFile(file, "utf8");
      register([raw, ...strings(JSON.parse(raw))]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await scrubRepointCredentialFiles(root);
  sanitize();
  await writeFile(`${root}/credential-binding.json`, JSON.stringify({ operation, complete: false }), { mode: 0o600 });
  return true;
}

/** Restore must not resurrect an archived account's credential file. Called before the fresh file is hydrated. */
export async function scrubRepointCredentialFiles(root: string): Promise<void> {
  for (const file of authPaths(root)) await rm(file, { force: true });
}

/** Called only after the new runner identity is bound, before its listener can admit native work. */
export async function completeCredentialRepoint(root: string, operation: string | undefined): Promise<void> {
  if (operation)
    await writeFile(`${root}/credential-binding.json`, JSON.stringify({ operation, complete: true }), { mode: 0o600 });
}
