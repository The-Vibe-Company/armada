// Shared macOS/Linux local launch preflight (THE-945). All probes are read-only; only an
// explicit terminal yes runs a fixed official installer. Never forward raw
// version/auth output or exceptions: they can contain harness credentials.
import { stripVTControlCharacters } from "node:util";
import { type Check, compareVersions, isDeepseekModel, setHerdrModel } from "@armada/core";
import type { ExecResult, Io } from "./io.ts";

export const MINIMUM_HERDR_VERSION = "0.9.1";
export type LocalHarness = "claude" | "codex" | "opencode" | "deepseek";
type LocalToolName = "herdr" | Exclude<LocalHarness, "deepseek"> | "dsh";

const TOOLS = {
  herdr: { command: "herdr", install: "curl -fsSL https://herdr.dev/install.sh | sh" },
  claude: { command: "claude", install: "curl -fsSL https://claude.ai/install.sh | bash" },
  codex: { command: "codex", install: "npm i -g @openai/codex" },
  opencode: { command: "opencode", install: "curl -fsSL https://opencode.ai/install | bash" },
  dsh: { command: "dsh", install: "" },
} as const;

export interface LocalTool {
  name: LocalToolName;
  command: string;
  version: string | null;
  state: "ready" | "missing" | "old" | "unusable" | "unknown";
  install: string;
}

export interface LocalTools {
  harnesses: LocalHarness[];
  profiles: LocalModelProfile[];
  availableModels: string[] | null;
  tools: LocalTool[];
  checks: Check[];
  /** Unknown sign-in is a warning; a missing model or sign-in prevents launch. */
  ready: boolean;
}

// Doctor checks only harnesses selected by local profiles. Cloud profiles need no local tools.
export function localHarnesses(config: {
  conductor?: unknown;
  herdr?: { profiles: Record<string, { harness: LocalHarness; model?: string }> };
}): LocalHarness[] {
  return [...new Set(Object.values(config.herdr?.profiles ?? {}).map((profile) => profile.harness))];
}

export interface LocalModelProfile {
  name: string;
  harness: "opencode" | "deepseek";
  model: string;
}

export function localModelProfiles(config: Parameters<typeof localHarnesses>[0]): LocalModelProfile[] {
  return Object.entries(config.herdr?.profiles ?? {}).flatMap(([name, profile]) =>
    profile.harness === "opencode" || profile.harness === "deepseek"
      ? [{ name, harness: profile.harness, model: profile.model ?? "" }]
      : [],
  );
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

async function signInCheck(io: Io, harness: "claude" | "codex"): Promise<Check> {
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
  } else {
    login = "codex login";
    const result = await probe(io, command, ["login", "status"]);
    if (result?.code === 0) state = "ready";
    else if (result?.code === 1 && /(?:^|\n)Not logged in\s*(?:\n|$)/i.test(`${result.stdout}\n${result.stderr}`))
      state = "missing";
  }
  return {
    id: `local-${command}-sign-in`,
    level: state === "ready" ? "ok" : state === "missing" ? "error" : "warning",
    message:
      state === "ready"
        ? `${command} reports credentials are present`
        : state === "missing"
          ? `${command} is not signed in`
          : `${command}: could not check sign-in`,
    fix: state === "ready" ? null : `the owner runs \`${login}\`; Armada never runs sign-in`,
  };
}

/** Exact complete model lines only; ignore diagnostics and never forward raw output. */
async function openCodeModels(io: Io): Promise<string[] | null> {
  const result = await probe(io, "opencode", ["models"]);
  if (result?.code !== 0) return null;
  return [
    ...new Set(
      stripVTControlCharacters(result.stdout)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^[^\s/#]+\/[^\s#]+$/.test(line)),
    ),
  ];
}

function modelCheck(profile: LocalModelProfile, available: string[] | null): Check {
  const model = profile.model;
  const matching = available?.filter((id) => profile.harness !== "deepseek" || isDeepseekModel(id)) ?? [];
  const ready = !!model && matching.includes(model);
  const label = profile.harness === "deepseek" ? "deepseek (OpenCode + DeepSeek model)" : "opencode";
  return {
    id: `local-opencode-${profile.harness}:${profile.name || model}`,
    level: ready ? "ok" : "error",
    message: `${label}${profile.name ? ` profile ${profile.name}` : ""}: ${
      ready
        ? `OpenCode lists ${model}`
        : available === null
          ? "could not check opencode models"
          : `${model || "the profile's model"} is not listed by OpenCode`
    }
${ready ? "" : `Available models: ${matching.length ? matching.map((id, i) => `${i + 1}. ${id} — model = ${JSON.stringify(id)}`).join("; ") : "none"}`}`.trimEnd(),
    fix: ready
      ? null
      : `the owner runs \`opencode\`, then \`/connect\`, or picks a model listed by \`opencode models\`; add \`model = "<exact model id>"\`${profile.name ? ` under [herdr.profiles.${profile.name}]` : ""}; Armada never handles the key`,
  };
}

/** Only a numbered owner choice writes an existing profile; JSON/CI never prompt or write. */
export async function offerLocalModels(
  io: Io,
  detected: LocalTools,
  configPath?: string,
  options: { readOnly?: boolean } = {},
): Promise<LocalTools> {
  if (detected.availableModels === null) return detected;
  let changed = false;
  for (const profile of detected.profiles) {
    if (modelCheck(profile, detected.availableModels).level === "ok") continue;
    const models = detected.availableModels.filter((id) => profile.harness !== "deepseek" || isDeepseekModel(id));
    if (
      !models.length ||
      options.readOnly ||
      !io.interactive ||
      io.env.CI ||
      !io.prompt ||
      !io.writeFile ||
      !configPath ||
      !profile.name
    )
      continue;
    io.stderr(
      `Choose a model for [herdr.profiles.${profile.name}]:\n${models.map((id, i) => `  ${i + 1}. ${id}`).join("\n")}\n`,
    );
    const before = await io.readFile(configPath);
    const answer = await io.prompt("Model number (Enter to leave unchanged): ", { hidden: false });
    if (answer === null) break;
    if (!answer.trim()) continue;
    const selected = /^\d+$/.test(answer.trim()) ? models[Number(answer.trim()) - 1] : undefined;
    if (!selected) {
      io.stderr("No model was selected; configuration unchanged.\n");
      continue;
    }
    try {
      if (before === null) throw new Error("missing config");
      const after = setHerdrModel(before, profile.name, selected);
      // Avoid overwriting an edit made while the owner answered.
      if ((await io.readFile(configPath)) !== before) throw new Error("config changed");
      await io.writeFile(configPath, after);
      profile.model = selected;
      changed = true;
      io.stderr(`Wrote model = ${JSON.stringify(selected)} under [herdr.profiles.${profile.name}] in ${configPath}.\n`);
    } catch {
      io.stderr(
        `Could not safely save the model in ${configPath}; add model = ${JSON.stringify(selected)} under [herdr.profiles.${profile.name}] yourself.\n`,
      );
    }
  }
  return changed ? detectLocalTools(io, detected.harnesses, detected.profiles) : detected;
}

/** Doctor-only information: native dsh is optional and never offered for install. */
export async function dshInformation(io: Io): Promise<Check> {
  const tool = await detectTool(io, "dsh");
  const present = tool.state === "ready";
  return {
    id: "local-dsh",
    level: "ok",
    message: `${present ? `dsh ${tool.version} is on PATH` : tool.state === "missing" ? "dsh is not installed" : "dsh installation could not be checked"}; information only: deepseek (OpenCode + DeepSeek model) runs OpenCode. Inspected dsh 0.1.5-rc.2 is one-shot, with no follow-up input or --resume`,
    fix: null,
  };
}

/** Structured, sanitized diagnostics. Starts no runtime, worktree or harness session. */
export async function detectLocalTools(
  io: Io,
  harnesses: LocalHarness[],
  configured: string[] | LocalModelProfile[] = [],
): Promise<LocalTools> {
  const profiles: LocalModelProfile[] = configured.map((profile) =>
    typeof profile === "string" ? { name: "", harness: "deepseek", model: profile } : { ...profile },
  );
  for (const harness of harnesses) {
    if ((harness === "opencode" || harness === "deepseek") && !profiles.some((profile) => profile.harness === harness))
      profiles.push({ name: "", harness, model: "" });
  }
  let availableModels: string[] | null = null;
  const tools: LocalTool[] = [];
  const checks: Check[] = [];
  const binaries = new Set(harnesses.map((harness) => (harness === "deepseek" ? "opencode" : harness)));
  for (const name of ["herdr", ...binaries] as Exclude<LocalToolName, "dsh">[]) {
    const tool = await detectTool(io, name);
    tools.push(tool);
    checks.push(toolCheck(tool));
    if (name !== "herdr" && tool.state === "ready") {
      if (name !== "opencode") checks.push(await signInCheck(io, name));
      else {
        availableModels = await openCodeModels(io);
        checks.push(...profiles.map((profile) => modelCheck(profile, availableModels)));
      }
    }
  }
  return {
    tools,
    profiles,
    availableModels,
    harnesses: [...new Set(harnesses)],
    checks,
    ready: !checks.some((check) => check.level === "error"),
  };
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
    if (tool.name === "dsh" || tool.state === "ready" || tool.state === "unknown") continue;
    const check = toolCheck(tool);
    const answer = await io.prompt(`${check.message}: \`${tool.install}\` — install now? [y/N] `, { hidden: false });
    if (answer === null) break;
    if (!/^(y|yes)$/i.test(answer.trim())) continue;
    attempted = true;
    // Resolve executable/args from trusted definitions, never detected output
    // or project config. Scripts are the documented official commands only.
    const definition = TOOLS[tool.name];
    const npm = tool.name === "codex";
    const code = await io
      .spawn(npm ? "npm" : "sh", npm ? ["i", "-g", "@openai/codex"] : ["-c", definition.install], {
        cwd: io.cwd,
        env: installerEnv(io.env),
      })
      .catch(() => null);
    if (code !== 0)
      io.stderr(
        `${tool.command} installation failed${code === null ? "" : ` (exit ${code})`}. Run \`${definition.install}\` yourself.\n`,
      );
  }
  if (!attempted) return detected;
  const result = await detectLocalTools(io, detected.harnesses, detected.profiles);
  if (result.tools.some((tool) => tool.state !== "ready"))
    io.stderr("Some local tools still cannot run. Check PATH, open a new terminal if needed, and retry.\n");
  return result;
}

/** THE-944/THE-947 call this before any launch side effect, including tokens. */
export async function ensureLocalTools(io: Io, harness: LocalHarness, model?: string): Promise<boolean> {
  const print = (detected: LocalTools) => {
    for (const check of detected.checks) {
      if (check.level === "ok") continue;
      io.stderr(`${check.message}${check.fix ? `: ${check.fix}` : ""}\n`);
    }
  };
  const detected = await detectLocalTools(
    io,
    [harness],
    harness === "deepseek" || harness === "opencode" ? [{ name: "", harness, model: model ?? "" }] : [],
  );
  print(detected);
  const result = await offerLocalInstalls(io, detected);
  if (result !== detected) print(result);
  return result.ready;
}

export const checkLocalTools = (
  io: Io,
  { harness, model }: { harness: LocalHarness; model?: string },
): Promise<boolean> => ensureLocalTools(io, harness, model);

/** Launch uses the selected exact ID for the worker after saving the owner's choice. */
export async function ensureLocalProfile(
  io: Io,
  configPath: string,
  name: string,
  profile: { harness: LocalHarness; model: string },
): Promise<string | null> {
  if (profile.harness !== "opencode" && profile.harness !== "deepseek")
    return (await ensureLocalTools(io, profile.harness, profile.model)) ? profile.model : null;
  const detected = await detectLocalTools(
    io,
    [profile.harness],
    [{ name, harness: profile.harness, model: profile.model }],
  );
  const installed = await offerLocalInstalls(io, detected);
  const chosen = await offerLocalModels(io, installed, configPath);
  for (const check of chosen.checks) {
    if (check.level !== "ok") io.stderr(`${check.message}${check.fix ? `: ${check.fix}` : ""}\n`);
  }
  return chosen.ready ? (chosen.profiles[0]?.model ?? null) : null;
}
