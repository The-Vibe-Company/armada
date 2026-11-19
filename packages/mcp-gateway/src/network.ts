import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

export class GatewayError extends Error {
  constructor(
    public readonly code: "denied" | "unsafe_endpoint" | "unsupported" | "needs_reconnect" | "busy" | "upstream",
    public readonly action: string,
  ) {
    super(code);
  }
}
export function endpoint(value: string | URL) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) =>
      /^(access_token|refresh_token|client_secret|api[_-]?key|token|authorization|password)$/i.test(key),
    )
  )
    throw new GatewayError("unsafe_endpoint", "Use a public HTTPS endpoint without credentials or fragments.");
  return url;
}
function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 2) ||
      (a === 198 && b === 51) ||
      (a === 203 && b === 0)
    );
  }
  return (
    isIP(address) === 6 &&
    /^[23]/.test(address) &&
    !address.toLowerCase().startsWith("2001:") &&
    !address.toLowerCase().startsWith("2002:")
  );
}
export const publicFetch: FetchLike = async (input, init) => {
  const req = new Request(input instanceof URL ? input.href : input, init);
  const url = endpoint(req.url);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
    throw new GatewayError("unsafe_endpoint", "Endpoint must resolve exclusively to public addresses.");
  const selected = addresses[0];
  if (!selected) throw new GatewayError("unsafe_endpoint", "Endpoint has no address.");
  const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        family: selected.family,
        method: req.method,
        headers: Object.fromEntries(req.headers),
        lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
        signal: req.signal,
      },
      (incoming) => receivePublicResponse(incoming, resolve, reject),
    );
    outgoing.on("error", () => reject(new GatewayError("upstream", "Upstream connection failed.")));
    outgoing.end(body);
  });
};
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
export function restrictedFetch(fetcher: FetchLike, allowed: (url: URL) => boolean) {
  const fetchRestricted: FetchLike = async (input, init) => {
    const req = new Request(input instanceof URL ? input.href : input, init);
    const url = endpoint(req.url);
    if (!allowed(url))
      throw new GatewayError("unsafe_endpoint", "Endpoint is outside the approved origin/path boundary.");
    const response = await fetcher(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: req.signal,
      redirect: "error",
    });
    if (response.status >= 300 && response.status < 400)
      throw new GatewayError("unsafe_endpoint", "Redirects are not permitted.");
    return response;
  };
  return fetchRestricted;
}
