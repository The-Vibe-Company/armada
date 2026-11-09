import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
/** Native working-directory selection, not an access-confinement boundary. Never echo refused input. */
export function validateHarnessCwd(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 4096 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  )
    throw Error("invalid_cwd");
  try {
    if (!statSync(value).isDirectory()) throw Error("invalid_cwd");
  } catch {
    throw Error("invalid_cwd");
  }
  return value;
}
