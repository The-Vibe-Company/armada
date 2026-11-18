import { SIZED_LAUNCH_ROUTE_V1 } from "@armada/core";
import type { RequestOptions } from "./index.ts";

/** Internal route client shared by the SDK and CLI, which have different receipt and auth policies. */
export function sandboxClient(
  post: <T>(route: string, body: unknown, readOnly: boolean, options?: RequestOptions) => Promise<T>,
) {
  return {
    launch<T>(body: unknown, options?: RequestOptions, variant?: "sized" | "access"): Promise<T> {
      const route =
        variant === "access"
          ? "sandbox/launch-access-v1"
          : variant === "sized"
            ? SIZED_LAUNCH_ROUTE_V1.slice("/api/v1/".length)
            : "sandbox/launch";
      return post(route, body, false, options);
    },
    status<T>(body: unknown, options?: RequestOptions): Promise<T> {
      return post("sandbox/status", body, true, options);
    },
    list<T>(body: unknown, options?: RequestOptions): Promise<T> {
      return post("sandbox/list", body, true, options);
    },
  };
}
