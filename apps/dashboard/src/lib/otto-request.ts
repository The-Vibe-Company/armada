/** One deadline policy for every Otto request; paginated reads share the same deadline. */
export const ottoDeadline = () => AbortSignal.timeout(10_000);

/** Transport only: callers retain their feature-specific status and schema handling. */
export async function ottoRequest(options: {
  serverUrl: string;
  token: string;
  orgId: string;
  path: string;
  params?: Record<string, string>;
  body?: unknown;
  method?: "GET" | "POST" | "PUT";
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<{ response: Response; body: unknown }> {
  const origin = new URL(options.serverUrl);
  if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password)
    throw new Error("Invalid Armada server URL");
  const url = new URL(`/api/v1/otto/${options.path}`, origin.origin);
  url.searchParams.set("org_id", options.orgId);
  for (const [key, value] of Object.entries(options.params ?? {})) url.searchParams.set(key, value);
  const signal = options.signal ?? ottoDeadline();
  const response = await (options.fetch ?? fetch)(url, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: "error",
    cache: "no-store",
    signal,
  });
  const body: unknown = await response.json().catch(() => null);
  signal.throwIfAborted();
  return { response, body };
}
