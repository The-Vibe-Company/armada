/** Native artifact-only proof. No model, provider or remote server calls; no shell needed by installer. */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRuntimeArtifactRoute } from "../packages/mcp-server/src/runtime-artifacts.ts";

async function main() {
  if (
    process.env.ARMADA_RUNTIME_HARNESS_SMOKE !== "local_native" ||
    process.platform !== "linux" ||
    Bun.version !== "1.4.2"
  )
    throw Error("native_harness_smoke_not_enabled");
  const root = await mkdtemp(join(tmpdir(), "native-harness-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const build = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../packages/agent-runtime/build-compiled.ts")],
      { stdout: "ignore", stderr: "ignore" },
    );
    if (await build.exited) throw Error("native_harness_build_failed");
    const out = resolve(import.meta.dir, "../packages/agent-runtime/dist/compiled"),
      manifest = await Bun.file(join(out, "manifest.json")).json();
    const ssl = Bun.spawn(
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
    const pem = await new Response(ssl.stdout).text();
    if (await ssl.exited) throw Error("fixture_tls_failed");
    const key = pem.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/)?.[0],
      cert = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
    if (!key || !cert) throw Error("fixture_tls_failed");
    const ca = join(root, "public-ca.pem");
    await writeFile(ca, cert);
    const published = join(root, "published");
    await mkdir(published);
    await copyFile(join(out, "codex.tar.gz"), join(published, manifest.harnesses.codex.archive.sha256));
    const route = createRuntimeArtifactRoute(published);
    let downloads = 0;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key, cert },
      async fetch(request) {
        downloads++;
        return (await route(request)) ?? new Response(null, { status: 404 });
      },
    });
    const input = {
      serverUrl: `https://127.0.0.1:${server.port}`,
      cacheDir: join(root, "cache"),
      harness: "codex",
      manifest,
    };
    async function install() {
      const child = Bun.spawn([join(out, "armada-runtime"), "install-harness"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, NODE_EXTRA_CA_CERTS: ca },
      });
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
      const output = await new Response(child.stdout).text();
      if (await child.exited) throw Error("native_harness_install_failed");
      return JSON.parse(output) as { root: string; executable: string; pathEntries: string[]; version: string };
    }
    const coldStart = performance.now(),
      first = await install(),
      coldMs = Math.round(performance.now() - coldStart);
    if (downloads !== 1) throw Error("native_harness_selection_failed");
    await server.stop(true);
    const warmStart = performance.now(),
      second = await install(),
      warmMs = Math.round(performance.now() - warmStart);
    if (JSON.stringify(first) !== JSON.stringify(second)) throw Error("native_harness_warm_cache_failed");
    await mkdir(join(root, "codex-home"), { mode: 0o700 });
    const version = Bun.spawnSync([second.executable, "--version"], {
      env: { PATH: second.pathEntries.join(":"), HOME: root, CODEX_HOME: join(root, "codex-home") },
      stdout: "pipe",
      stderr: "ignore",
    });
    if (version.exitCode !== 0 || version.stdout.toString().trim() !== `codex-cli ${second.version}`)
      throw Error("native_harness_version_failed");
    const native = Bun.spawn(
      [
        second.executable,
        "-c",
        'cli_auth_credentials_store="file"',
        "-c",
        'mcp_oauth_credentials_store="file"',
        "app-server",
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: {
          PATH: `${second.pathEntries.join(":")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          HOME: root,
          CODEX_HOME: join(root, "codex-home"),
        },
      },
    );
    const deadline = setTimeout(() => native.kill("SIGKILL"), 10000);
    try {
      native.stdin.write(
        `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "armada-harness-smoke", version: "1" }, capabilities: { experimentalApi: true } } })}\n`,
      );
      const reader = native.stdout.getReader();
      let text = "";
      while (!text.includes("\n")) {
        const result = await reader.read();
        if (result.done) throw Error("native_harness_initialize_failed");
        text += new TextDecoder().decode(result.value);
      }
      reader.releaseLock();
      const reply = JSON.parse(text.split("\n")[0] ?? "{}");
      if (reply.id !== 1 || reply.error || !reply.result) throw Error("native_harness_initialize_failed");
    } finally {
      clearTimeout(deadline);
      native.stdin.end();
      native.kill();
      await native.exited;
    }
    console.log(
      `Native selected Codex cache smoke passed: cold ${coldMs}ms, offline warm ${warmMs}ms, version and real app-server handshake verified`,
    );
  } finally {
    await server?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch((error: unknown) => {
  const safe = new Set([
    "native_harness_build_failed",
    "fixture_tls_failed",
    "native_harness_install_failed",
    "native_harness_selection_failed",
    "native_harness_warm_cache_failed",
    "native_harness_version_failed",
    "native_harness_initialize_failed",
  ]);
  console.error(error instanceof Error && safe.has(error.message) ? error.message : "native_harness_smoke_failed");
  process.exitCode = 1;
});
