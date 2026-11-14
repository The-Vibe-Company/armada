interface ServerRequestDrain {
  fetch(request: Request): Response | Promise<Response>;
  readonly requests: ReadonlySet<Promise<unknown>>;
  beginDrain(): void;
}

/** Track admitted handlers and POST streams without waiting on idle GET notification streams. */
export function createServerRequestDrain(handler: (request: Request) => Promise<Response>): ServerRequestDrain {
  let draining = false;
  const requests = new Set<Promise<unknown>>();
  const fetch = (request: Request) => {
    if (draining)
      return Response.json({ error: "temporarily_unavailable" }, { status: 503, headers: { "retry-after": "5" } });
    const pending = handler(request).then((response) => {
      // Gateway POST tools use SSE responses: the handler can return before the
      // admitted tool finishes. GET notification streams instead end at MCP close.
      if (request.method !== "POST" || !response.body) return response;
      const reader = response.body.getReader();
      const finished = Promise.withResolvers<void>();
      requests.add(finished.promise);
      void finished.promise.then(() => requests.delete(finished.promise));
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              controller.close();
              finished.resolve();
            } else controller.enqueue(chunk.value);
          } catch (error) {
            controller.error(error);
            finished.resolve();
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            finished.resolve();
          }
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    });
    requests.add(pending);
    void pending.finally(() => requests.delete(pending)).catch(() => {});
    return pending;
  };
  return {
    fetch,
    requests,
    beginDrain: () => {
      draining = true;
    },
  };
}
