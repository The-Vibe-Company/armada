import {
  apiUrl,
  jsonPost,
  type RequestPolicy,
  type RequestResult,
  requestApi,
  TEMPLATE_LAUNCH_ROUTE,
} from "./request.ts";
import { sandboxClient } from "./sandboxes.ts";

interface CommandPolicy extends Pick<RequestPolicy, "fetch" | "timeoutMs"> {
  token: () => string;
  renewToken?: (signal?: AbortSignal) => Promise<string>;
  invalidPath: (error: TypeError) => never;
}

/** Internal route client for CLI commands. Output, session storage and error presentation belong to the caller. */
export function commandClient(
  origin: string,
  policy: CommandPolicy,
  decode: (result: RequestResult, path: string, url: URL) => unknown,
) {
  async function request<T>(path: string, init: RequestInit = {}) {
    let url: URL;
    try {
      url = apiUrl(origin, path);
    } catch (error) {
      if (error instanceof TypeError) return policy.invalidPath(error);
      throw error;
    }
    const { fetch, timeoutMs, renewToken } = policy;
    const result = await requestApi(url, init, {
      fetch,
      timeoutMs,
      token: policy.token(),
      signal: init.signal,
      ...(renewToken ? { renewToken: () => renewToken(init.signal ?? undefined) } : {}),
    });
    return decode(result, path, url) as T;
  }

  function control<T>(route: string, body: unknown, signal?: AbortSignal) {
    return request<T>(`/api/v1/${route}`, { ...jsonPost(body), ...(signal ? { signal } : {}) });
  }

  return {
    request,
    control,
    sandboxes: sandboxClient((route, body, _readOnly, options) => control(route, body, options?.signal)),
    launchFromTemplate<T>(body: unknown, signal: AbortSignal) {
      return control<T>(TEMPLATE_LAUNCH_ROUTE, body, signal);
    },
    deleteSandbox<T>(id: string, org?: string) {
      return request<T>(`/api/v1/sandboxes/${id}${org ? `?org=${encodeURIComponent(org)}` : ""}`, { method: "DELETE" });
    },
    golden<T>(
      operation:
        | "capabilities"
        | "list"
        | "remove"
        | "visibility"
        | "build/cancel"
        | "build/find"
        | "build/status"
        | "retirement/dry-run"
        | "retirement/reconcile"
        | "create"
        | "update"
        | "update-add-repos"
        | "connect"
        | "snapshot"
        | "size-policy",
      body: unknown,
      signal?: AbortSignal,
    ) {
      return control<T>(`golden/${operation}`, body, signal);
    },
    dockerSnapshot<T>(operation: "create" | "get" | "list" | "rebuild", body: unknown) {
      return control<T>(`docker/snapshots/${operation}`, body);
    },
    dockerHost<T>(operation: "list" | "limits" | "register-token" | "retention" | "revoke", body: unknown) {
      return control<T>(`docker/hosts/${operation}`, body);
    },
    token<T>(operation: "create" | "list" | "revoke", body?: unknown) {
      if (body === undefined) return request<T>(`/api/v1/token/${operation}`, { method: "POST" });
      return control<T>(`token/${operation}`, body);
    },
  };
}
