import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { RequestRefused } from "./errors.ts";
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
    throw new RequestRefused("invalid_cwd");
  try {
    if (!statSync(value).isDirectory()) throw new RequestRefused("invalid_cwd");
  } catch {
    throw new RequestRefused("invalid_cwd");
  }
  return value;
}
