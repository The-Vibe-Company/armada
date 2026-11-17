import { isAbsolute, resolve } from "node:path";
import { validateReadableVariables } from "@armada/core";
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

/** Separate private readable channel; never relax the credential/control allowlist. */
export function validateExecReadables(value: unknown, credentialFreeBuilder = false): Record<string, string> {
  const variables = validateReadableVariables(value ?? {});
  if (
    (credentialFreeBuilder && Object.keys(variables).length) ||
    Object.keys(variables).some((key) => allowed.has(key))
  )
    throw Error("invalid_exec_readables");
  return variables;
}

/** Each harness runs under a private HOME (legacy ~/.claude.json, XDG caches, refreshed native auth).
 * Git's global configuration must stay the exec one: launch writes the owner's identity and the GitHub
 * credential helper there (core `gitSetupCommand` through exec, managed tools through the exec HOME).
 * A private HOME alone would hide both, so `git push` prompts for a username (#2577). */
export function privateHarnessHome(
  root: string,
  harness: "claude" | "codex" | "opencode",
  env: Record<string, string>,
  exec: ExecEnvironment,
  fallbackHome = process.env.HOME ?? "/home/user",
): string {
  env.GIT_CONFIG_GLOBAL ??= exec.GIT_CONFIG_GLOBAL ?? `${exec.HOME ?? fallbackHome}/.gitconfig`;
  env.HOME = `${root}/${harness}/home`;
  env.XDG_CONFIG_HOME = `${env.HOME}/.config`;
  env.XDG_CACHE_HOME = `${env.HOME}/.cache`;
  env.XDG_DATA_HOME = `${env.HOME}/.local/share`;
  return env.HOME;
}
