import { isAbsolute, resolve } from "node:path";
import type { ExecEnvironment } from "./protocol.ts";

const allowed = new Set(["GH_TOKEN", "GITHUB_TOKEN", "HOME", "PATH", "GIT_CONFIG_GLOBAL", "GIT_TERMINAL_PROMPT"]);
/** Private bootstrap projection only; never merge a fork/model/process environment wholesale. */
export function validateExecEnvironment(value: unknown, credentialFreeBuilder = false): ExecEnvironment {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid_exec_environment");
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key) || typeof item !== "string" || !item.length || item.length > 16384 || item.includes("\0"))
      throw Error("invalid_exec_environment");
    if (["GH_TOKEN", "GITHUB_TOKEN"].includes(key)) {
      if (credentialFreeBuilder) throw Error("builder_credentials_forbidden");
      if ([...item].some((char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) > 126))
        throw Error("invalid_exec_environment");
    }
    if (["HOME", "GIT_CONFIG_GLOBAL"].includes(key) && (!isAbsolute(item) || resolve(item) !== item))
      throw Error("invalid_exec_environment");
    if (key === "GIT_TERMINAL_PROMPT" && item !== "0") throw Error("invalid_exec_environment");
    result[key] = item;
  }
  return Object.freeze(result);
}
export function execCredentialValues(env: ExecEnvironment): string[] {
  return [env.GH_TOKEN, env.GITHUB_TOKEN].filter((v): v is string => typeof v === "string");
}
