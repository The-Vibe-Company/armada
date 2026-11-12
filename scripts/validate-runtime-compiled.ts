/** Explicit, billable native smoke, not a unit test. Never prints harness output or credentials. */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent } from "../packages/core/src/index.ts";

if (process.env.ARMADA_COMPILED_SMOKE !== "create_real_inference")
  throw Error("Set ARMADA_COMPILED_SMOKE=create_real_inference");
if (!process.env.OPENAI_API_KEY) throw Error("OPENAI_API_KEY required in environment");
const artifact = resolve(import.meta.dir, "../packages/agent-runtime/dist/compiled");
const manifest = await Bun.file(join(artifact, "manifest.json")).json();
for (const file of [manifest.runtime, manifest.harnesses.codex.archive]) {
  const bytes = await Bun.file(join(artifact, file.path)).arrayBuffer();
  if (
    bytes.byteLength !== file.bytes ||
    createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !== file.sha256
  )
    throw Error("artifact_digest_mismatch");
}
const directory = await mkdtemp(join(tmpdir(), "armada-compiled-"));
const token = crypto.randomUUID();
const sink = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const batch = (await request.json()) as { events: { sequence: number }[] };
    return Response.json({ acknowledgedSequence: batch.events.at(-1)?.sequence ?? 0 });
  },
});
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = reservation.port;
await reservation.stop(true);
let child: ReturnType<typeof Bun.spawn> | undefined;
const started = performance.now();
let checkpoint: (() => Promise<unknown>) | undefined;
try {
  const unpack = Bun.spawn(["tar", "-xzf", join(artifact, "codex.tar.gz"), "-C", directory]);
  if (await unpack.exited) throw Error("harness_extract_failed");
  child = Bun.spawn([join(artifact, "armada-runtime")], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  if (typeof child.stdin === "number" || !child.stdin) throw Error("stdin_missing");
  child.stdin.write(
    JSON.stringify({
      root: join(directory, "private"),
      cwd: directory,
      port,
      grant: { token, sandboxId: "compiled-smoke", generation: "smoke", expiresAt: Date.now() + 180000 },
      codexExecutable: join(directory, "bin/codex"),
      claudeExecutable: "/not-selected",
      codexEnv: {
        PATH: `${directory}/codex-path:${process.env.PATH ?? "/usr/bin:/bin"}`,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      },
      claudeEnv: {},
      ingestUrl: `http://127.0.0.1:${sink.port}`,
    }),
  );
  child.stdin.end();
  async function call(body: Record<string, unknown>) {
    const response = await fetch(`http://127.0.0.1:${port}/v1`, {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: { "x-armada-runner-grant": token },
      body: JSON.stringify({ version: 1, requestId: crypto.randomUUID(), sandboxId: "compiled-smoke", ...body }),
    });
    if (!response.ok) throw Error("runtime_request_failed");
    return response.json() as Promise<{ result: { promptId: string; status: string; events?: AgentEvent[] } }>;
  }
  checkpoint = () => call({ op: "checkpoint" });
  for (let attempt = 0; ; attempt++) {
    try {
      await call({ op: "health" });
      break;
    } catch {
      if (attempt >= 100) throw Error("runtime_boot_failed");
      await Bun.sleep(100);
    }
  }
  console.log(`Compiled runtime ready after ${Math.round(performance.now() - started)} ms (including extraction)`);
  const prompt = await call({
    op: "prompt",
    input: {
      sandboxId: "compiled-smoke",
      harness: "codex",
      model: process.env.ARMADA_COMPILED_SMOKE_MODEL ?? "gpt-6.1-sol",
      text: "Reply with exactly COMPILED_OK. Do not use tools.",
    },
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await call({ op: "getPrompt", promptId: prompt.result.promptId });
    if (state.result.status === "finished") {
      const events = (await call({ op: "events", limit: 1000 })).result.events ?? [];
      if (!events.some((event) => event.kind === "message" && !event.partial && event.text.trim() === "COMPILED_OK"))
        throw Error("real_codex_response_missing");
      if (!events.some((event) => event.kind === "other" && event.type === "armada/turnUsage"))
        throw Error("real_codex_usage_missing");
      console.log("Compiled runtime + pinned real Codex app-server: response and usage verified");
      process.exitCode = 0;
      break;
    }
    if (["failed", "interrupted"].includes(state.result.status)) throw Error("real_codex_prompt_failed");
    if (attempt === 119) throw Error("real_codex_prompt_timeout");
    await Bun.sleep(1000);
  }
} finally {
  let cleanupFailed = false;
  try {
    if (checkpoint) await checkpoint();
  } catch {
    cleanupFailed = true;
  } finally {
    child?.kill();
    if (child) await child.exited;
    await sink.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
  if (cleanupFailed) {
    console.error("runtime_checkpoint_cleanup_failed");
    process.exitCode = 1;
  }
}
