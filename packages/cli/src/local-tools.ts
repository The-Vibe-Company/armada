// Shared macOS/Linux local launch preflight (THE-945). All probes are read-only; only an
// explicit terminal yes runs a fixed official installer. Never forward raw
// version/auth output or exceptions: they can contain harness credentials.
import { stripVTControlCharacters } from "node:util";
import { type Check, compareVersions } from "@armada/core";
import type { ExecResult, Io } from "./io.ts";

export const MINIMUM_HERDR_VERSION = "0.9.1";
export type LocalHarness = "claude" | "codex" | "opencode" | "deepseek";
type LocalToolName = "herdr" | LocalHarness;

const TOOLS = {
  herdr: { command: "herdr", install: "curl -fsSL https://herdr.dev/install.sh | sh" },
  claude: { command: "claude", install: "curl -fsSL https://claude.ai/install.sh | bash" },
  codex: { command: "codex", install: "npm i -g @openai/codex" },
  opencode: { command: "opencode", install: "curl -fsSL https://opencode.ai/install | bash" },
  deepseek: { command: "dsh", install: "npm i -g @deepseek-ai/dsh" },
} as const;

export interface LocalTool {
  name: LocalToolName;
  command: string;
  version: string | null;
  state: "ready" | "missing" | "old" | "unusable" | "unknown";
  install: string;
}

export interface LocalTools {
  tools: LocalTool[];
  checks: Check[];
  /** Unknown sign-in is a warning; a known missing sign-in prevents launch. */
  ready: boolean;
}

// Structural boundary shared with THE-944, which owns config.ts. Also accepts
// deepseek profiles when THE-947 adds them. Cloud profiles need no local tools.
export function localHarnesses(config: {
  conductor?: unknown;
  herdr?: { profiles: Record<string, { harness: LocalHarness }> };
}): LocalHarness[] {
  return [...new Set(Object.values(config.herdr?.profiles ?? {}).map((profile) => profile.harness))];
}

async function probe(io: Io, command: string, args: string[]): Promise<ExecResult | null> {
  if (!io.exec) return null;
  return io.exec(command, args, { cwd: io.cwd }).catch(() => null);
}

/** Keep only the numeric version, never arbitrary stdout or a prerelease suffix. */
function versionOf(result: ExecResult): { version: string; prerelease: boolean } | null {
  if (result.code !== 0) return null;
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    const match = line
      .trim()
      .match(
        /^(?:(?:herdr|claude|codex(?:-cli)?|opencode|dsh)\s+)?v?(\d+\.\d+\.\d+)(-[\w.-]+)?(?:\+[\w.-]+)?(?:\s|\(|$)/i,
      );
    if (match?.[1]) return { version: match[1], prerelease: !!match[2] };
  }
  return null;
}

async function detectTool(io: Io, name: LocalToolName): Promise<LocalTool> {
  const definition = TOOLS[name];
  const base = { name, ...definition, version: null };
  if (!io.exec) return { ...base, state: "unknown" };
  let result: ExecResult;
  try {
    result = await io.exec(definition.command, ["--version"], { cwd: io.cwd });
  } catch (error) {
    const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    return { ...base, state: missing ? "missing" : "unusable" };
  }
  const found = versionOf(result);
  if (!found) return { ...base, state: "unusable" };
  const old = name === "herdr" && (found.prerelease || compareVersions(found.version, MINIMUM_HERDR_VERSION) < 0);
  return { ...base, version: found.version, state: old ? "old" : "ready" };
}

function toolCheck(tool: LocalTool): Check {
  const { command, state, version } = tool;
  const message =
    state === "ready"
      ? `${command} ${version} is on PATH${tool.name === "herdr" ? ` (minimum ${MINIMUM_HERDR_VERSION})` : ""}`
      : state === "missing"
        ? `${command} is not installed`
        : state === "old"
          ? `herdr needs stable ${MINIMUM_HERDR_VERSION} or newer; found ${version}`
          : state === "unknown"
            ? `${command}: could not check installation`
            : `${command} could not report a usable version`;
  return {
    id: `local-${command}`,
    level: state === "ready" ? "ok" : "error",
    message,
    fix:
      state === "ready"
        ? null
        : `\`${tool.install}\`${state === "unusable" ? `; then check \`${command} --version\` and PATH` : ""}`,
  };
}

type SignIn = "ready" | "missing" | "unknown";

/** Installers need paths, not the owner's provider keys or Armada sign-in. */
function installerEnv(env: Io["env"]): Io["env"] {
  const names = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "npm_config_prefix",
    "NPM_CONFIG_PREFIX",
  ];
  return Object.fromEntries(names.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]));
}

async function signInCheck(io: Io, harness: LocalHarness): Promise<Check> {
  const command = TOOLS[harness].command;
  let state: SignIn = "unknown";
  let login: string;
  if (harness === "claude") {
    login = "claude auth login";
    const result = await probe(io, command, ["auth", "status"]);
    if (result && (result.code === 0 || result.code === 1)) {
      try {
        const status: unknown = JSON.parse(result.stdout);
        if (typeof status === "object" && status !== null && "loggedIn" in status) {
          if (status.loggedIn === true && result.code === 0) state = "ready";
          if (status.loggedIn === false) state = "missing";
        }
      } catch {
        /* An older harness or an unrecognized response: unknown. */
      }
    }
  } else if (harness === "codex") {
    login = "codex login";
    const result = await probe(io, command, ["login", "status"]);
    if (result?.code === 0) state = "ready";
    else if (result?.code === 1 && /(?:^|\n)Not logged in\s*(?:\n|$)/i.test(`${result.stdout}\n${result.stderr}`))
      state = "missing";
  } else if (harness === "opencode") {
    login = "opencode auth login";
    const result = await probe(io, command, ["auth", "list"]);
    if (result?.code === 0) {
      // The documented list includes both stored credentials and active env
      // providers. Counts establish presence, not validity for a given model.
      const text = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
      const count = text.match(/\b(\d+) credentials\b/);
      const environment = text.match(/\b(\d+) environment variables?\b/);
      if (count) state = Number(count[1]) > 0 || Number(environment?.[1] ?? 0) > 0 ? "ready" : "missing";
    }
  } else {
    // dsh exposes provider setup in its Web UI, no general read-only auth
    // status/login command. Do not boot a profile just to check sign-in.
    login = "dsh web";
  }
  return {
    id: `local-${command}-sign-in`,
    level: state === "ready" ? "ok" : state === "missing" ? "error" : "warning",
    message:
      state === "ready"
        ? `${command} reports credentials are present${harness === "opencode" ? "; the owner must check the selected provider" : ""}`
        : state === "missing"
          ? `${command} is not signed in`
          : `${command}: could not check sign-in`,
    fix:
      state === "ready"
        ? null
        : `the owner runs \`${login}\`${harness === "deepseek" ? " and configures the provider in Settings → Models" : ""}; Armada never runs sign-in`,
  };
}

/** Structured, sanitized diagnostics. Starts no runtime, worktree or harness session. */
export async function detectLocalTools(io: Io, harnesses: LocalHarness[]): Promise<LocalTools> {
  const tools: LocalTool[] = [];
  const checks: Check[] = [];
  for (const name of ["herdr", ...new Set(harnesses)] as LocalToolName[]) {
    const tool = await detectTool(io, name);
    tools.push(tool);
    checks.push(toolCheck(tool));
    if (name !== "herdr" && tool.state === "ready") checks.push(await signInCheck(io, name));
  }
  return { tools, checks, ready: !checks.some((check) => check.level === "error") };
}

/** Shared by doctor and launch. A declined offer does not prevent other offers. */
export async function offerLocalInstalls(
  io: Io,
  detected: LocalTools,
  options: { readOnly?: boolean } = {},
): Promise<LocalTools> {
  const platform = io.platform ?? process.platform;
  if (
    options.readOnly ||
    !io.interactive ||
    io.env.CI ||
    !io.prompt ||
    !io.spawn ||
    (platform !== "darwin" && platform !== "linux")
  )
    return detected;
  let attempted = false;
  for (const tool of detected.tools) {
    if (tool.state === "ready" || tool.state === "unknown") continue;
    const check = toolCheck(tool);
    const answer = await io.prompt(`${check.message}: \`${tool.install}\` — install now? [y/N] `, { hidden: false });
    if (answer === null) break;
    if (!/^(y|yes)$/i.test(answer.trim())) continue;
    attempted = true;
    // Resolve executable/args from trusted definitions, never detected output
    // or project config. Scripts are the documented official commands only.
    const definition = TOOLS[tool.name];
    const npm = tool.name === "codex" || tool.name === "deepseek";
    const code = await io
      .spawn(
        npm ? "npm" : "sh",
        npm ? ["i", "-g", tool.name === "codex" ? "@openai/codex" : "@deepseek-ai/dsh"] : ["-c", definition.install],
        { cwd: io.cwd, env: installerEnv(io.env) },
      )
      .catch(() => null);
    if (code !== 0)
      io.stderr(
        `${tool.command} installation failed${code === null ? "" : ` (exit ${code})`}. Run \`${definition.install}\` yourself.\n`,
      );
  }
  if (!attempted) return detected;
  const result = await detectLocalTools(
    io,
    detected.tools.filter((tool) => tool.name !== "herdr").map((tool) => tool.name as LocalHarness),
  );
  if (result.tools.some((tool) => tool.state !== "ready"))
    io.stderr("Some local tools still cannot run. Check PATH, open a new terminal if needed, and retry.\n");
  return result;
}

/** THE-944/THE-947 call this before any launch side effect, including tokens. */
export async function ensureLocalTools(io: Io, harness: LocalHarness): Promise<boolean> {
  const print = (detected: LocalTools) => {
    for (const check of detected.checks) {
      if (check.level === "ok") continue;
      io.stderr(`${check.message}${check.fix ? `: ${check.fix}` : ""}\n`);
    }
  };
  const detected = await detectLocalTools(io, [harness]);
  print(detected);
  const result = await offerLocalInstalls(io, detected);
  if (result !== detected) print(result);
  return result.ready;
}

export const checkLocalTools = (io: Io, { harness }: { harness: LocalHarness }): Promise<boolean> =>
  ensureLocalTools(io, harness);
