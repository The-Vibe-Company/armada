import { expect, test } from "bun:test";
import { publicFetch, restrictedFetch } from "../src/index.ts";

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

test("malformed peer status rejects safely instead of escaping the HTTPS response callback", async () => {
  // Isolated test-only dial replacement routes the real HTTPS request/parser to
  // a raw local HTTP peer. Production DNS policy and Response are not mocked.
  // Isolation lets the parent observe a callback crash without killing the suite.
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "mcp-peer-"));
  const built = await Bun.build({
    entrypoints: [new URL("../src/network.ts", import.meta.url).pathname],
    target: "node",
  });
  if (!built.success || !built.outputs[0]) throw Error("Network fixture compilation failed");
  const module = join(directory, "network.mjs");
  await writeFile(module, await built.outputs[0].text());
  const script = `
    import { createServer, connect } from 'node:net';
    import { globalAgent } from 'node:https';
    import { publicFetch, GatewayError } from ${JSON.stringify(module)};
    let replies = 0;
    const peer = createServer(socket => socket.once('data', () => { replies++; socket.end('HTTP/1.1 600 Invalid\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n'); }));
    await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
    const address = peer.address();
    globalAgent.createConnection = () => connect(address.port, '127.0.0.1');
    try {
      try { await publicFetch('https://93.184.216.34/'); throw Error('invalid status accepted'); }
      catch (error) { if (!(error instanceof GatewayError) || error.code !== 'upstream') throw error; }
      if (replies !== 1) throw Error('Malformed peer response was not exercised');
      console.log('malformed peer safely rejected');
    } finally { globalAgent.destroy(); await new Promise(resolve => peer.close(resolve)); }
  `;
  try {
    const child = Bun.spawn(["node", "--input-type=module", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout.trim()).toBe("malformed peer safely rejected");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
