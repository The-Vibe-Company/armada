import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type PluginSetting, pluginSettingSchema } from "@armada/plugin-api";
import { lock } from "proper-lockfile";

export function appConfigPath(env: Record<string, string | undefined> = process.env): string {
  return (
    env.ARMADA_APP_CONFIG ||
    join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "armada", "config.json")
  );
}
export function parseAppConfig(body: string | null): Record<string, unknown> {
  const config: unknown = body === null ? {} : JSON.parse(body);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("app config must be an object");
  return config as Record<string, unknown>;
}
export function pluginSettings(config: Record<string, unknown>): PluginSetting[] {
  const settings = pluginSettingSchema.array().parse(config.plugins ?? []);
  if (new Set(settings.map((s) => s.id)).size !== settings.length) throw new Error("duplicate plugin settings id");
  return settings;
}
export async function readPluginSettings(configPath: string): Promise<PluginSetting[]> {
  let body: string | null;
  try {
    body = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    body = null;
  }
  return pluginSettings(parseAppConfig(body));
}
/** Shared by the CLI and app: preserve all other settings and provider configuration. */
export function setPluginEnabled(
  config: Record<string, unknown>,
  id: string,
  enabled: boolean,
): Record<string, unknown> {
  const settings = pluginSettings(config);
  const previous = settings.find((s) => s.id === id);
  return {
    ...config,
    plugins: [...settings.filter((s) => s.id !== id), { ...previous, id, enabled, config: previous?.config ?? {} }],
  };
}

/** Atomic app configuration write, shared by the app and terminal switches. */
async function saveAppConfig(path: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** All app/CLI patches read fresh configuration while holding the same process-safe lock. */
export async function updateAppConfig(
  path: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const release = await lock(path, { realpath: false, retries: { retries: 30, minTimeout: 20, maxTimeout: 200 } });
  try {
    let body: string | null;
    try {
      body = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      body = null;
    }
    await saveAppConfig(path, update(parseAppConfig(body)));
  } finally {
    await release();
  }
}
