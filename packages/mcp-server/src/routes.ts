import type { Caller } from "./caller.ts";
import type { ControlOptions } from "./control.ts";

export interface ControlRouteContext {
  route: string;
  caller: Caller;
  body: Record<string, unknown>;
  options: ControlOptions;
}

type ControlRouteHandler = (context: ControlRouteContext) => unknown;

export function defineRoutes<Handlers extends Record<string, ControlRouteHandler>>(module: string, handlers: Handlers) {
  return { module, handlers };
}

export function registerRoutes(modules: readonly ReturnType<typeof defineRoutes>[]) {
  const routes = new Map<string, { module: string; method: "POST"; handler: ControlRouteHandler }>();
  for (const { module, handlers } of modules) {
    for (const [route, handler] of Object.entries(handlers)) {
      const owner = routes.get(route);
      if (owner) throw new Error(`Duplicate control route "${route}" in modules "${owner.module}" and "${module}".`);
      routes.set(route, { module, method: "POST", handler });
    }
  }
  return routes;
}
