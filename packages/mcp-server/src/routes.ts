import type { Caller } from "./caller.ts";
import type { ControlOptions } from "./control.ts";

export interface ControlRouteContext {
  route: string;
  request: Request | undefined;
  caller: Caller;
  body: Record<string, unknown>;
  options: ControlOptions;
}

type ControlRouteHandler = (context: ControlRouteContext) => unknown;

type RequestRoute = {
  methods: readonly ("GET" | "POST")[];
  respond: (request: Request, options: ControlOptions) => Response | Promise<Response>;
};

type Route = RequestRoute | { methods: readonly ["POST"]; handler: ControlRouteHandler };

export function defineRoutes<Handlers extends Record<string, ControlRouteHandler | RequestRoute>>(
  module: string,
  handlers: Handlers,
) {
  return { module, handlers };
}

export function registerRoutes(modules: readonly ReturnType<typeof defineRoutes>[]) {
  const routes = new Map<string, Route & { module: string }>();
  for (const { module, handlers } of modules) {
    for (const [route, handler] of Object.entries(handlers)) {
      const owner = routes.get(route);
      if (owner) throw new Error(`Duplicate control route "${route}" in modules "${owner.module}" and "${module}".`);
      routes.set(
        route,
        typeof handler === "function" ? { module, methods: ["POST"], handler } : { module, ...handler },
      );
    }
  }
  return routes;
}
