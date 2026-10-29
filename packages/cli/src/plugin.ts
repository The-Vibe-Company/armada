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
import { testPlugin } from "./plugin-test.ts";

export async function pluginCommand(io: Io, rest: string[], json: boolean, report?: string): Promise<number> {
  const [command, id] = rest;
  if (command === "test" && id && rest.length === 2) return testPlugin(io, id, report, json);
  if (report) throw new UsageError("--report applies to plugin test only");
  if (
    !(
      (command === "list" && rest.length === 1) ||
      ((command === "enable" || command === "disable") && rest.length === 2)
    )
  )
    throw new UsageError("use armada plugin list, plugin enable|disable <id> or plugin test <dir> [--report <file>]");
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
