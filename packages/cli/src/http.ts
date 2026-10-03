import type { Fetch } from "@armada/core";

/**
 * Polls can leave sockets idle longer than a router's NAT mapping. Closing
 * after each response prevents the next poll from reusing that silent socket.
 * Connection: close works in both Node and Bun without a runtime dependency.
 */
export function cliFetch(doFetch: Fetch = fetch): Fetch {
  return (url, init) => {
    const headers = new Headers(init.headers);
    headers.set("Connection", "close");
    return doFetch(url, { ...init, headers });
  };
}
