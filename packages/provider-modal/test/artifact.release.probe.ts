import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitSetupCommand } from "@armada/core";
import {
  createGenerationGrants,
  createRunnerTransport,
  loadRunnerArtifact,
  type Machine,
  type Scope,
} from "../src/index.ts";

const dist = join(import.meta.dir, "../../agent-runtime/dist");
const manifest = Bun.file(join(dist, "manifest.json"));
const nativeBuild = (await manifest.exists()) && (await manifest.json()).artifact !== "portable-bundle";
if (process.platform !== "linux" || !nativeBuild)
  throw new Error("Release conformance requires the Linux native runtime build");
async function verifyArtifact(root: string) {
  const deadline = AbortSignal.timeout(15_000);
  const artifact = await loadRunnerArtifact(dist);
  expect(artifact.bundle.length).toBeGreaterThan(1000);
  const preload = join(root, "readiness.js");
  await Bun.write(join(root, "main.js"), artifact.bundle);
  await Bun.write(
    preload,
    `const serve = Bun.serve;
Bun.serve = (options) => {
  const server = serve(options);
  if (options.hostname === "0.0.0.0" && options.port === 0) process.send(server.port);
  return server;
};`,
  );
  for (const [name, version] of [
    ["claude", "2.1.322"],
    ["codex", "0.167.0"],
    ["opencode", "1.19.5"],
  ]) {
    const native = Bun.spawn([join(dist, name ?? ""), "--version"], {
      stdout: "pipe",
      stderr: "ignore",
      signal: deadline,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        CODEX_HOME: join(root, "codex"),
        CLAUDE_CONFIG_DIR: join(root, "claude"),
      },
    });
    const [exit, output] = await Promise.all([native.exited, new Response(native.stdout).text()]);
    expect(exit).toBe(0);
    expect(output).toContain(version ?? "");
  }
  const scope: Scope = {
    orgId: "org",
    userId: "user",
    visibility: "private",
    binding: { workspace: "workspace", environment: "main", appId: "ap_bound" },
  };
  const row: Machine = {
    info: { id: "logical", name: "test", state: "ready", providerState: "active", labels: {} },
    phase: "active",
    generation: 1,
    grantExpiresAt: Date.now() + 60_000,
    golden: false,
    ttlSeconds: 60,
    physicalName: "physical",
  };
  const grants = createGenerationGrants(crypto.getRandomValues(new Uint8Array(32)), scope);
  const initialNative = {
    tokens: {
      access_token: "synthetic-artifact-access",
      refresh_token: "synthetic-artifact-refresh",
      account_id: "native-artifact",
    },
  };
  const rotatedNative = {
    tokens: {
      access_token: "synthetic-rotated-access",
      refresh_token: "synthetic-rotated-refresh",
      account_id: "native-artifact",
    },
  };
  let acknowledgeNative = false,
    nativeRevision = 0,
    publishedNative: string | undefined;
  const privateIngest = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        generation: string;
        events: unknown[];
        nativeAuth?: { authJson: string; expectedRevision: number };
      };
      if (body.nativeAuth) {
        expect(request.headers.get("x-armada-runner-grant")).toBeTruthy();
        expect(body.generation).toBe(String(row.generation));
        expect(body.events).toEqual([]);
        if (!acknowledgeNative) return new Response(null, { status: 503 });
        publishedNative = body.nativeAuth.authJson;
        nativeRevision++;
        return Response.json({ authRevision: nativeRevision, committed: true });
      }
      return Response.json({ acknowledgedSequence: 0 });
    },
  });
  let process: ReturnType<typeof Bun.spawn> | undefined;
  let orphan: ReturnType<typeof Bun.spawn> | undefined;
  async function bootRuntime() {
    const grant = grants.issue(row);
    const readiness = Promise.withResolvers<number>();
    const child = Bun.spawn(["setsid", Bun.which("bun") ?? "bun", "--preload", preload, join(root, "main.js")], {
      signal: deadline,
      ipc(port: unknown) {
        if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535) readiness.resolve(port);
        else readiness.reject(Error("runtime sent an invalid listening port"));
      },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: root },
    });
    process = child;
    const input = child.stdin;
    if (typeof input === "number" || !input) throw Error("missing private pipe");
    input.write(
      JSON.stringify({
        root,
        cwd: root,
        port: 0,
        grant,
        claudeExecutable: join(dist, "claude"),
        codexExecutable: join(dist, "codex"),
        claudeEnv: { ANTHROPIC_API_KEY: "synthetic-model-env-only" },
        codexEnv: {},
        codexAuthJson: publishedNative ?? JSON.stringify(initialNative),
        nativeAuthRevision: nativeRevision,
        credentialFreeBuilder: false,
        execEnv: {
          GH_TOKEN: "synthetic-artifact-github",
          GITHUB_TOKEN: "synthetic-artifact-github",
          HOME: root,
          PATH: "/usr/local/bin:/usr/bin:/bin",
          GIT_CONFIG_GLOBAL: join(root, "fixture-gitconfig"),
          GIT_TERMINAL_PROMPT: "0",
        },
        ingestUrl: `http://127.0.0.1:${privateIngest.port}/native-private`,
      }),
    );
    input.end();
    const boot = await Promise.race([
      readiness.promise.then((port) => ({ port })),
      child.exited.then((exitCode) => ({ exitCode })),
    ]);
    deadline.throwIfAborted();
    return { boot, grant };
  }
  async function start() {
    const { boot, grant } = await bootRuntime();
    if ("exitCode" in boot) throw Error(`runtime exited before listening (exit ${boot.exitCode})`);
    const url = `http://127.0.0.1:${boot.port}`;
    const transport = createRunnerTransport(async () => ({
      url,
      connectToken: "proxy-fixture",
      grant: grant.token,
      expiresAt: grant.expiresAt,
    }));
    return { transport, url };
  }
  try {
    const first = await start();
    let { transport } = first;
    const denied = await fetch(first.url, { method: "POST", body: "{}", signal: deadline });
    expect(denied.status).toBe(401);
    const result = await transport.call<{ stdout: string; exitCode: number }>(row, "exec", {
      input: { sandboxId: row.info.id, command: "printf actual-runtime" },
    });
    expect(result.stdout).toBe("actual-runtime");
    expect(result.exitCode).toBe(0);
    const environment = await transport.call<{ stdout: string; exitCode: number }>(row, "exec", {
      input: {
        sandboxId: row.info.id,
        cwd: root,
        command: `printf '%s:%s:%s' "$GH_TOKEN" "$GITHUB_TOKEN" "\${ANTHROPIC_API_KEY-unset}"`,
      },
    });
    expect(environment.exitCode).toBe(0);
    expect(environment.stdout).toBe("[REDACTED]:[REDACTED]:unset");
    const helper = await transport.call<{ stdout: string; exitCode: number }>(row, "exec", {
      input: {
        sandboxId: row.info.id,
        cwd: root,
        command:
          gitSetupCommand({ id: 1, login: "fixture", name: "Fixture", email: "fixture@example.test" }) +
          `
credentials=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill)
case "$credentials" in *"password=$GH_TOKEN"*) printf helper-ok;; *) exit 1;; esac`,
      },
    });
    expect(helper.exitCode).toBe(0);
    expect(helper.stdout).toContain("helper-ok");
    expect(helper.stdout).not.toContain("synthetic-artifact-github");
    const configured = await transport.call<{ revision: string }>(row, "configureMcp", {
      configuration: { revision: "fixture-empty-config", servers: {} },
    });
    expect(configured).toEqual({ revision: "fixture-empty-config" });
    const rotated = await transport.call<{ stdout: string; exitCode: number }>(row, "exec", {
      input: {
        sandboxId: row.info.id,
        cwd: root,
        command: `umask 077; printf '%s' '${JSON.stringify(rotatedNative)}' > codex/auth.json; printf '%s' '${rotatedNative.tokens.refresh_token}'`,
      },
    });
    expect(rotated).toMatchObject({ exitCode: 0, stdout: "[REDACTED]" });
    orphan = Bun.spawn(["setsid", Bun.which("bun")!, "-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
      stdout: "pipe",
      stderr: "ignore",
      signal: deadline,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", CODEX_HOME: join(root, "codex") },
    });
    await (orphan.stdout as ReadableStream<Uint8Array>).getReader().read();
    process?.kill();
    await process?.exited;
    expect((await bootRuntime()).boot).toEqual({ exitCode: 1 });
    await orphan.exited;
    expect(orphan.exitCode).not.toBe(0);
    expect(await Bun.file(join(root, "codex/auth.json")).text()).toBe(JSON.stringify(rotatedNative));
    acknowledgeNative = true;
    ({ transport } = await start());
    expect(await Bun.file(join(root, "codex/auth.json")).text()).toBe(JSON.stringify(rotatedNative));
    expect(publishedNative).toBe(JSON.stringify(rotatedNative));
    acknowledgeNative = false;
    await expect(transport.call(row, "checkpoint", {})).rejects.toBeDefined();
    expect(await Bun.file(join(root, "codex/auth.json")).exists()).toBe(true);
    expect(publishedNative).toBe(JSON.stringify(rotatedNative));
    acknowledgeNative = true;
    const checkpoint = await transport.call<{ generation: string; watermark: number; acknowledgedSequence: number }>(
      row,
      "checkpoint",
      {},
    );
    expect(checkpoint).toMatchObject({ generation: "1", watermark: 0, acknowledgedSequence: 0 });
    expect(publishedNative).toBe(JSON.stringify(rotatedNative));
    expect(await Bun.file(join(root, "codex/auth.json")).exists()).toBe(false);
    expect(await transport.call<typeof checkpoint>(row, "checkpoint", {})).toEqual(checkpoint);
    process?.kill();
    await process?.exited;
    ({ transport } = await start());
    expect(await transport.call<typeof checkpoint>(row, "checkpoint", {})).toEqual(checkpoint);
    await expect(
      transport.call(row, "exec", { input: { sandboxId: row.info.id, command: "echo forbidden" } }),
    ).rejects.toMatchObject({ code: "sandbox_not_ready" });
    process?.kill();
    await process?.exited;
    row.generation = 2;
    ({ transport } = await start());
    expect(await transport.call(row, "health", {})).toMatchObject({ generation: "2", ready: true });
    const nativeRestored = await transport.call<{ stdout: string; exitCode: number }>(row, "exec", {
      input: {
        sandboxId: row.info.id,
        cwd: root,
        command: `node -e 'const v=JSON.parse(require("fs").readFileSync("codex/auth.json","utf8")); if(v.tokens.refresh_token!=="${rotatedNative.tokens.refresh_token}")process.exit(1); process.stdout.write("current-native-auth")'`,
      },
    });
    expect(nativeRestored).toMatchObject({ exitCode: 0, stdout: "current-native-auth" });
    const resumed = await transport.call<{ stdout: string }>(row, "exec", {
      input: { sandboxId: row.info.id, command: "printf restored" },
    });
    expect(resumed.stdout).toBe("restored");
    deadline.throwIfAborted();
  } finally {
    orphan?.kill();
    await orphan?.exited;
    process?.kill();
    await process?.exited;
    await privateIngest.stop(true);
  }
}

const root = await mkdtemp(join(tmpdir(), "armada-artifact-"));
try {
  await verifyArtifact(root);
} finally {
  await rm(root, { recursive: true, force: true });
}
