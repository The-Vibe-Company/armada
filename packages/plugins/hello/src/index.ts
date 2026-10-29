import type { PluginContext } from "@armada/plugin-api";

export function activate(ctx: PluginContext): void {
  ctx.log.info("hello activated");
}
