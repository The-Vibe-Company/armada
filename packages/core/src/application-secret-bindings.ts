import { parseReadableVariableBindings } from "./readable-variables.ts";

export interface ApplicationSecretBinding {
  key: string;
  secretId: string;
  version: number;
}

/** Same value-free key/UUID/version contract as readable variables, excluding public frontend keys. */
export function parseApplicationSecretBindings(input: unknown): ApplicationSecretBinding[] {
  if (!Array.isArray(input) || input.length > 64) throw Error("Invalid secret bindings.");
  const mapped = input.map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !["key", "secretId", "version"].includes(key)) ||
      typeof value.key !== "string" ||
      /^(NEXT_PUBLIC_|VITE_|PUBLIC_)/i.test(value.key)
    )
      throw Error("Invalid secret bindings.");
    return { key: value.key, variableId: value.secretId, version: value.version };
  });
  return parseReadableVariableBindings(mapped).map(({ key, variableId, version }) => ({
    key,
    secretId: variableId,
    version,
  }));
}
