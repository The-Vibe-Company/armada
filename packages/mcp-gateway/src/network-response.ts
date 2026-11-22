import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

export class GatewayError extends Error {
  constructor(
    public readonly code: "denied" | "unsafe_endpoint" | "unsupported" | "needs_reconnect" | "busy" | "upstream",
    public readonly action: string,
  ) {
    super(code);
  }
}

export function receivePublicResponse(
  incoming: IncomingMessage,
  resolve: (response: Response) => void,
  reject: (error: GatewayError) => void,
) {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers))
      if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    const status = incoming.statusCode;
    if (status === undefined || !Number.isInteger(status) || status < 200 || status > 599)
      throw new GatewayError("upstream", "Upstream returned an invalid HTTP status.");
    if (status >= 300 && status < 400) {
      incoming.destroy();
      reject(new GatewayError("unsafe_endpoint", "Redirects are not permitted. Configure the final endpoint."));
      return;
    }
    resolve(
      new Response([204, 205, 304].includes(status) ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
        status,
        headers,
      }),
    );
  } catch (error) {
    incoming.destroy();
    reject(
      error instanceof GatewayError
        ? error
        : new GatewayError("upstream", "Upstream returned an invalid HTTP response."),
    );
  }
}
