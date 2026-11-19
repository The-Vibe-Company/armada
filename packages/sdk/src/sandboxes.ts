import type { RequestOptions } from "./index.ts";

/** Internal route client shared by the SDK and CLI, which have different receipt and auth policies. */
export function sandboxClient(
  post: <T>(
    route: string,
    body: unknown,
    readOnly: boolean,
    options?: RequestOptions,
    defaultTimeoutMs?: number,
  ) => Promise<T>,
) {
  return {
    launch<T>(body: unknown, options?: RequestOptions) {
      return post<T>("sandbox/launch", body, false, options);
    },
    status<T>(body: unknown, options?: RequestOptions) {
      return post<T>("sandbox/status", body, true, options);
    },
    list<T>(body: unknown, options?: RequestOptions) {
      return post<T>("sandbox/list", body, true, options);
    },
    advice<T>(body: unknown, options?: RequestOptions) {
      return post<T>("sandbox/advice", body, true, options);
    },
    "bind-credential"<T>(body: unknown, options?: RequestOptions) {
      return post<T>("sandbox/bind-credential", body, false, options);
    },
    exec<T>(body: unknown, options?: RequestOptions) {
      return post<T>("sandbox/exec", body, false, options);
    },
    extend<T>(body: unknown, options?: RequestOptions) {
      return post<T>("sandbox/extend", body, false, options);
    },
    interrupt<T>(body: unknown, options?: RequestOptions) {
      return post<T>("sandbox/interrupt", body, false, options);
    },
    logs<T>(body: unknown, options?: RequestOptions) {
      return post<T>("logs/read", body, true, options);
    },
    recovery<T>(body: unknown, options?: RequestOptions) {
      return post<T>("sandbox/recovery", body, true, options);
    },
    report<T>(body: unknown, options?: RequestOptions) {
      return post<T>("sandbox/report", body, false, options);
    },
    send<T>(body: unknown, options?: RequestOptions) {
      return post<T>("sandbox/send", body, false, options);
    },
    steer<T>(body: unknown, options?: RequestOptions) {
      return post<T>("sandbox/steer", body, false, options);
    },
    stop<T>(body: unknown, options?: RequestOptions) {
      return post<T>("sandbox/stop", body, false, options);
    },
    wait<T>(body: unknown, options?: RequestOptions, defaultTimeoutMs?: number) {
      return post<T>("sandbox/wait", body, true, options, defaultTimeoutMs);
    },
  };
}
