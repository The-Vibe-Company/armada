import { BUNDLED_PLUGINS } from "@armada/daemon/plugins/catalog";
import { parseAppConfig, pluginSettings, setPluginEnabled } from "@armada/daemon/plugins/config";
import {
  appConfigPath,
  catalogList,
  parsePluginStatus,
  pluginStatusPath,
  renderPluginList,
} from "@armada/daemon/plugins/list";
import { type Io, UsageError } from "./io.ts";

export async function pluginCommand(io: Io, rest: string[], json: boolean): Promise<number> {
  const [command, id] = rest;
  if (
    !(
      (command === "list" && rest.length === 1) ||
      ((command === "enable" || command === "disable") && rest.length === 2)
    )
  )
    throw new UsageError("use armada plugin list or plugin enable|disable <id>");
  const path = appConfigPath(io.env);
  const config = parseAppConfig(await io.readFile(path));
  const body = await io.readFile(pluginStatusPath(path));
  const boot = body === null ? null : parsePluginStatus(body);
  const catalog = boot?.catalog ?? BUNDLED_PLUGINS;
  if (command === "list") {
    const plugins = catalogList(catalog, pluginSettings(config), boot?.plugins);
    io.stdout(json ? `${JSON.stringify(plugins)}\n` : renderPluginList(plugins));
    return 0;
  }
  if (!id || !catalog.some((entry) => entry.id === id)) throw new UsageError(`unknown bundled plugin ${id}`);
  if (!io.updateAppConfig) throw new UsageError("app configuration is not writable");
  await io.updateAppConfig(path, (current) => setPluginEnabled(current, id, command === "enable"));
  io.stdout(
    `Plugin ${id} ${command === "enable" ? "enabled" : "disabled"}. Restart the daemon to apply this change.\n`,
  );
  return 0;
}
