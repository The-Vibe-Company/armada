import { expect, test } from "bun:test";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { publicFetch, restrictedFetch } from "../src/index.ts";
import { receivePublicResponse } from "../src/network.ts";

test("outbound boundary rejects unsafe URLs, origin escape and redirects before forwarding secrets", async () => {
  let calls = 0;
  const fetcher = restrictedFetch(
    async () => {
      calls++;
      return new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } });
    },
    (url) => url.origin === "https://approved.example",
  );
  for (const url of [
    "http://approved.example",
    "https://user:password@approved.example",
    "https://approved.example/#fragment",
    "https://elsewhere.example",
    "https://approved.example/?access_token=fixture",
    "https://approved.example/?api_key=fixture",
  ]) {
    await expect(fetcher(url, { headers: { authorization: "Bearer fixture" } })).rejects.toMatchObject({
      code: "unsafe_endpoint",
    });
  }
  expect(calls).toBe(0);
  await expect(fetcher("https://approved.example", { method: "POST", body: "fixture" })).rejects.toMatchObject({
    code: "unsafe_endpoint",
  });
  expect(calls).toBe(1);
});

test("public HTTPS dialer refuses private, metadata, mapped and non-global literal addresses without opening a socket", async () => {
  for (const host of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "100.64.0.1",
    "192.168.0.1",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "[fc00::1]",
  ]) {
    await expect(publicFetch(`https://${host}/`)).rejects.toMatchObject({ code: "unsafe_endpoint" });
  }
});

test("automatic discovery does not mistake an HTTP success for MCP initialization", async () => {
  const { createRemoteAuthResolver } = await import("../src/index.ts");
  const resolve = createRemoteAuthResolver({ fetch: async () => Response.json({ jsonrpc: "2.0", id: 0, result: {} }) });
  await expect(resolve({ url: "https://endpoint.example/mcp", transport: "http" })).rejects.toMatchObject({
    code: "upstream",
  });
});

test("legitimate resource query configuration survives outbound endpoint validation", async () => {
  let observed = "";
  const fetcher = restrictedFetch(
    async (url) => {
      observed = String(url);
      return new Response(null, { status: 204 });
    },
    (url) => url.origin === "https://approved.example",
  );
  await fetcher("https://approved.example/mcp?project_ref=project&read_only=true");
  expect(observed).toBe("https://approved.example/mcp?project_ref=project&read_only=true");
});

test("issuer discovery rejects query-bearing issuer identifiers while resource queries remain allowed", async () => {
  const { discoverOAuthIssuer } = await import("../src/index.ts");
  const issuer = "https://issuer.example?project_ref=not-an-issuer";
  let requests = 0;
  await expect(
    discoverOAuthIssuer(issuer, async () => {
      requests++;
      return Response.json({
        issuer,
        authorization_endpoint: "https://issuer.example/authorize",
        token_endpoint: "https://issuer.example/token",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    }),
  ).rejects.toMatchObject({ code: "unsafe_endpoint" });
  expect(requests).toBe(0);
});

test("malformed peer status rejects the request and closes the response", async () => {
  const incoming = new IncomingMessage(new Socket());
  incoming.statusCode = 600;
  const response = new Promise<Response>((resolve, reject) => {
    queueMicrotask(() => receivePublicResponse(incoming, resolve, reject));
  });

  await expect(response).rejects.toMatchObject({
    code: "upstream",
    action: "Upstream returned an invalid HTTP status.",
  });
  expect(incoming.destroyed).toBe(true);
});
