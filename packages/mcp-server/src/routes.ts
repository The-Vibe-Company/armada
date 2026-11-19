import type { Caller } from "./caller.ts";
import type { ControlOptions } from "./control.ts";

export interface ControlRouteContext {
  route: string;
  request?: Request | undefined;
  caller: Caller;
  body: Record<string, unknown>;
  options: ControlOptions;
}

type ControlRouteHandler = (context: ControlRouteContext) => unknown;

type Method = "GET" | "POST" | "DELETE";
type Dispatch = (request: Request) => Promise<Response | null>;

type CommandRoute = {
  methods: readonly Method[];
  handler: ControlRouteHandler;
  readBody?: (request: Request) => Record<string, unknown> | Promise<Record<string, unknown>>;
  responseStatus?: (result: unknown) => number;
};

type RequestRoute = {
  methods: readonly Method[];
} & (
  | { respond: (request: Request, options: ControlOptions) => Response | Promise<Response> }
  | { earlyRespond: (request: Request, options: ControlOptions, dispatch: Dispatch) => Response | Promise<Response> }
);

type Route = (CommandRoute | RequestRoute) & { pattern?: RegExp };

export function defineRoutes<Handlers extends Record<string, ControlRouteHandler | Route>>(
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

export function matchControlRoute(routes: ReturnType<typeof registerRoutes>, path: string) {
  const exact = routes.get(path);
  if (exact && !exact.pattern) return exact;
  for (const route of routes.values()) {
    if (route.pattern?.test(path)) return route;
  }
}
