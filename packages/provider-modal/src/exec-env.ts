import { posix } from "node:path";
import { refusal } from "./errors.ts";
import type { ExecEnvironment } from "./ports.ts";

const allowed = new Set(["GH_TOKEN", "GITHUB_TOKEN", "HOME", "PATH", "GIT_CONFIG_GLOBAL", "GIT_TERMINAL_PROMPT"]);
export function projectGitHubExecEnvironment(
  launchEnv: Readonly<Record<string, string>>,
  resolved?: ExecEnvironment,
): ExecEnvironment {
  const source = resolved ?? launchEnv;
  if (resolved && Object.keys(resolved).some((key) => !allowed.has(key)))
    throw refusal("invalid_request", "Unsupported exec environment configuration.");
  const result: ExecEnvironment = {
    HOME: "/home/user",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: "/home/user/.gitconfig",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of resolved ? allowed : ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = (source as Record<string, string | undefined>)[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.length || value.length > 16384 || value.includes("\0"))
      throw refusal("invalid_request", "Invalid exec environment configuration.");
    if (
      (key === "GH_TOKEN" || key === "GITHUB_TOKEN") &&
      Array.from(value).some((c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126)
    )
      throw refusal("invalid_request", "Invalid GitHub exec credential.");
    if ((key === "HOME" || key === "GIT_CONFIG_GLOBAL") && (!posix.isAbsolute(value) || posix.resolve(value) !== value))
      throw refusal("invalid_request", "Exec paths must be canonical absolute POSIX paths.");
    if (key === "GIT_TERMINAL_PROMPT" && value !== "0")
      throw refusal("invalid_request", "Interactive git credential prompts are forbidden.");
    Object.assign(result, { [key]: value });
  }
  return result;
}

const TRUSTED_TOOL_PATH = "/usr/local/bin:/usr/bin:/bin";
export function withTrustedHarnessPath(env: Readonly<Record<string, string>>): Record<string, string> {
  const path = env.PATH ?? TRUSTED_TOOL_PATH;
  if (
    typeof path !== "string" ||
    !path.length ||
    Array.from(path).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    path.split(":").some((dir) => !posix.isAbsolute(dir) || posix.normalize(dir) !== dir)
  )
    throw refusal("invalid_request", "Harness PATH must be an explicit absolute POSIX directory list.");
  return { ...env, PATH: path };
}
