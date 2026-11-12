/** Local/staging native proof only: private loopback TLS fixture, no model/provider/remote server call. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  if (process.env.ARMADA_DIALOUT_SMOKE !== "local_native" || Bun.version !== "1.4.2" || process.platform !== "linux")
    throw Error("native_dialout_smoke_not_enabled");
  const root = await mkdtemp(join(tmpdir(), "native-dialout-"));
  const httpOnly = process.argv.includes("--http-only");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // The ephemeral TLS PRIVATE key stays in memory, never argv, disk, repository or output.
    const tls = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
        "-keyout",
        "-",
        "-out",
        "-",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const pem = await new Response(tls.stdout).text();
    if (await tls.exited) throw Error("fixture_tls_failed");
    const key = pem.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/)?.[0];
    const cert = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
    if (!key || !cert) throw Error("fixture_tls_failed");
    const ca = join(root, "public-ca.pem");
    await writeFile(ca, cert); // Public trust certificate only.
    const binary = join(root, "armada-runtime");
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        join(import.meta.dir, "../packages/agent-runtime/src/main.ts"),
        "--outfile",
        binary,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    if (await build.exited) throw Error("fixture_compile_failed");
    const enrolmentToken = `armada_enrol_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
    const runtimeToken = `armada_runtime_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
    const finished = Promise.withResolvers<void>();
    const requests = [httpOnly ? "health-http-1" : "health-ws", "health-http-2"];
    let consumed = false,
      results = 0,
      socket: import("bun").ServerWebSocket<unknown> | undefined;
    const command = (requestId: string) => ({ version: 1, requestId, sandboxId: "native-smoke", op: "health" });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key, cert },
      async fetch(request, instance) {
        try {
          const path = new URL(request.url).pathname;
          const authorization = request.headers.get("authorization");
          if (path === "/api/runtime/enrol") {
            if (consumed || authorization !== `Bearer ${enrolmentToken}`) return new Response(null, { status: 401 });
            consumed = true;
            return Response.json(
              {
                sandboxId: "native-smoke",
                epoch: "1",
                runtimeToken,
                configuration: {
                  root: join(root, "private"),
                  cwd: root,
                  grant: { expiresAt: Date.now() + 60000 },
                  claudeExecutable: "/not-selected",
                  codexExecutable: "/not-selected",
                  claudeEnv: {},
                  codexEnv: {},
                },
              },
              { headers: { "cache-control": "no-store" } },
            );
          }
          if (authorization !== `Bearer ${runtimeToken}` || request.headers.get("x-armada-runtime-epoch") !== "1")
            return new Response(null, { status: 401 });
          if (path === "/api/runtime/channel") {
            if (!httpOnly && instance.upgrade(request, { data: undefined })) return;
            return new Response(null, { status: 403 }); // Exercise denied upgrade fallback.
          }
          if (path === "/api/runtime/results") {
            const reply = (await request.json()) as {
              epoch: string;
              requestId: string;
              status: number;
              body: { result: { generation: string; ready: boolean } };
            };
            if (
              reply.requestId !== requests[results] ||
              reply.epoch !== "1" ||
              reply.status !== 200 ||
              reply.body.result.generation !== "1" ||
              reply.body.result.ready !== true
            )
              throw Error("fixture_result_failed");
            results++;
            socket?.close();
            return Response.json({ epoch: "1", requestId: reply.requestId });
          }
          if (path === "/api/runtime/poll") {
            if (results === 2) {
              finished.resolve();
              return Response.json({ epoch: "1", command: null });
            }
            return Response.json({ epoch: "1", command: command(requests[results] ?? "invalid") });
          }
          throw Error("fixture_unexpected_request");
        } catch {
          finished.reject(Error("fixture_protocol_failed"));
          return new Response(null, { status: 500 });
        }
      },
      websocket: {
        open(ws) {
          socket = ws;
          ws.send(JSON.stringify({ type: "command", epoch: "1", request: command(requests[0] ?? "invalid") }));
        },
        message() {},
      },
    });
    child = Bun.spawn([binary, "dialout"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, NODE_EXTRA_CA_CERTS: ca },
    });
    if (!child.stdin || typeof child.stdin === "number") throw Error("fixture_stdin_failed");
    child.stdin.write(JSON.stringify({ serverUrl: `https://127.0.0.1:${server.port}`, enrolmentToken }));
    child.stdin.end();
    await Promise.race([
      finished.promise,
      child.exited.then(() => {
        throw Error("fixture_runtime_exited");
      }),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(Error("fixture_timed_out")), 45000);
      }),
    ]);
    child.kill("SIGTERM");
    if (await child.exited) throw Error("fixture_shutdown_failed");
    console.log(
      httpOnly ? "Native dialout smoke passed: rejected upgrade -> HTTPS" : "Native dialout smoke passed: WSS -> HTTPS",
    );
  } finally {
    if (deadline) clearTimeout(deadline);
    child?.kill();
    if (child) await child.exited;
    await server?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch(() => {
  console.error("native_dialout_smoke_failed");
  process.exitCode = 1;
});
