/** Opt-in authenticated test; never part of unit verify. No credential inspection. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexDriver } from "../src/codex.ts";
import { HarnessError } from "../src/errors.ts";
import type { DriverContext, DriverEvent } from "../src/protocol.ts";
import { createRedactor, HarnessState } from "../src/state.ts";

if (process.argv[2] !== "--run") throw Error("Pass --run to opt into a bounded real model test");
const root = await mkdtemp(join(tmpdir(), "armada-codex-smoke-"));
await mkdir(join(root, "codex"));
const executable = resolve(import.meta.dir, "../dist/codex");
// Inherit the already selected harness environment without inspecting any credential.
const env = { ...process.env, HOME: root, CODEX_HOME: join(root, "codex") } as Record<string, string>;
let driver = new CodexDriver({ executable, cwd: root, env });
const sessions = new Map<string, string>();
const hooks = new Map<string, () => void>();
const events: DriverEvent[] = [];
const deadline = AbortSignal.timeout(90000);
const timeout = setTimeout(() => {
  void driver.close().catch(() => {});
}, 90000);
const context = (text: string, lane = "memory"): DriverContext => {
  if (deadline.aborted) throw new HarnessError("harness_timeout");
  return {
    request: { sandboxId: "smoke", harness: "codex", model: "gpt-6.1-sol", reasoningEffort: "medium", text },
    signal: deadline,
    ...(sessions.get(lane) ? { sessionId: sessions.get(lane) as string } : {}),
    session: (id) => {
      sessions.set(lane, id);
    },
    emit: (e) => {
      events.push(e);
      if (e.kind === "message" && e.partial) {
        const hook = hooks.get(lane);
        hooks.delete(lane);
        hook?.();
      }
    },
  };
};
try {
  const first = driver.start(
    context("Do not use tools or inspect files. Remember the benign test word lantern. Reply only: remembered."),
  );
  await first.done;
  if (!sessions.get("memory")) throw Error("missing_session");
  await driver.close();
  const state = new HarnessState(
    root,
    createRedactor(
      Object.entries(env)
        .filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key))
        .map(([, value]) => value),
    ),
  );
  await state.checkpoint({ sandboxId: "smoke", generation: "codex-smoke-generation" });
  await new HarnessState(
    root,
    createRedactor(
      Object.entries(env)
        .filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key))
        .map(([, value]) => value),
    ),
  ).checkpoint({ sandboxId: "smoke", generation: "codex-smoke-generation" });
  await state.restore();
  driver = new CodexDriver({ executable, cwd: root, env });
  const secondEvents = events.length;
  await driver.start(
    context(
      "Do not use tools or inspect files. What benign test word did I ask you to remember? Reply with the word only.",
    ),
  ).done;
  const recalled = events
    .slice(secondEvents)
    .some((e) => e.kind === "message" && !e.partial && e.text.toLowerCase().includes("lantern"));
  if (!recalled) throw Error("resume_recall_failed");
  await Promise.all([
    driver.start(context("No tools or files. Reply only alpha.", "parallel-a")).done,
    driver.start(context("No tools or files. Reply only beta.", "parallel-b")).done,
  ]);
  if (sessions.get("parallel-a") === sessions.get("parallel-b")) throw Error("smoke_conversation_collision");
  let interruptedAction: Promise<void> | undefined;
  hooks.set("interrupt", () => {
    interruptedAction = interrupted.interrupt();
    void interruptedAction.catch(() => {});
  });
  const interrupted = driver.start(
    context("No tools or files. Count integers from 1 through 1000, one per line.", "interrupt"),
  );
  const survivor = driver.start(context("No tools or files. Reply only survivor.", "survivor"));
  if ((await interrupted.done) !== "interrupted") throw Error("smoke_interrupt_failed");
  await interruptedAction;
  if ((await survivor.done) !== "finished") throw Error("smoke_scoped_interrupt_failed");
  let steerAction: Promise<void> | undefined;
  hooks.set("steer", () => {
    steerAction = steered.steer("Stop counting. No tools. Reply only redirected.");
    void steerAction.catch(() => {});
  });
  const beforeSteer = events.length;
  const steered = driver.start(
    context("No tools or files. Count integers from 1 through 1000, one per line.", "steer"),
  );
  if ((await steered.done) !== "finished") throw Error("smoke_steer_failed");
  await steerAction;
  if (
    !events
      .slice(beforeSteer)
      .some((e) => e.kind === "message" && !e.partial && e.text.toLowerCase().includes("redirected"))
  )
    throw Error("smoke_steer_delivery_failed");
  let publicMcpTool: boolean | undefined;
  if (process.argv.includes("--public-mcp")) {
    const start = events.length;
    const turn = driver.start({
      ...context(
        "Do not use local files or local tools. Use the docs MCP microsoft_docs_search tool exactly once to search for TypeScript interfaces in Microsoft documentation. Then reply DONE.",
        "public-mcp",
      ),
      mcp: {
        revision: "public-readonly-v1",
        servers: { docs: { type: "http", url: "https://learn.microsoft.com/api/mcp" } },
      },
    });
    if ((await turn.done) !== "finished") throw Error("smoke_public_mcp_failed");
    publicMcpTool = events
      .slice(start)
      .some(
        (e) =>
          e.kind === "message" &&
          e.tools.some(
            (t) =>
              t.name.includes("microsoft_docs_search") && t.result && !t.result.isError && t.result.output !== null,
          ),
      );
    // Claude tool results arrive in a separate SDK user frame, correlated by call ID.
    if (!publicMcpTool) {
      const calls = new Set(
        events
          .slice(start)
          .flatMap((e) =>
            e.kind === "message"
              ? e.tools.filter((t) => t.name.includes("microsoft_docs_search")).map((t) => t.id)
              : [],
          ),
      );
      publicMcpTool = events
        .slice(start)
        .some(
          (e) =>
            e.kind === "message" &&
            e.tools.some((t) => calls.has(t.id) && t.result && !t.result.isError && t.result.output !== null),
        );
    }
    if (!publicMcpTool) throw Error("smoke_public_mcp_tool_missing");
  }
  console.log(
    JSON.stringify({
      code: "ok",
      resumeRecall: true,
      publicMcpTool,
      sanitizedFilesystemRestore: true,
      checkpointLostResponseRetry: true,
      parallelConversations: true,
      scopedInterrupt: true,
      restartSteer: true,
      partialEvents: events.filter((e) => e.kind === "message" && e.partial).length,
    }),
  );
} catch (error) {
  // Only allowlisted typed outcomes, never provider messages or request bodies.
  const errorInfo = events.filter((e) => e.kind === "other" && e.type === "turn/completed").at(-1)?.data as
    | { turn?: { status?: string; error?: { codexErrorInfo?: unknown } } }
    | undefined;
  const code = errorInfo?.turn?.error?.codexErrorInfo;
  const typed =
    typeof code === "string" && /^[a-zA-Z_]{1,80}$/.test(code)
      ? code
      : code && typeof code === "object"
        ? Object.keys(code)[0]
        : "smoke_failed";
  console.log(
    JSON.stringify({
      code: typed,
      driverCode:
        error instanceof HarnessError
          ? error.code
          : error instanceof Error && /^(?:codex|harness|smoke|resume|missing)_[a-z_]+$/.test(error.message)
            ? error.message
            : "smoke_failed",
    }),
  );
  if (
    errorInfo?.turn?.status === "failed" &&
    code !== undefined &&
    process.argv.includes("--record-terminal") &&
    typeof typed === "string" &&
    /^[a-zA-Z_]{1,80}$/.test(typed)
  ) {
    const terminal = {
      method: "turn/completed",
      params: {
        threadId: "recorded-thread",
        turn: {
          id: "recorded-turn",
          status: errorInfo?.turn?.status ?? "failed",
          items: [],
          error: {
            message: "[provider message omitted]",
            codexErrorInfo: typeof code === "string" ? typed : { [typed]: { httpStatusCode: null } },
          },
        },
      },
    };
    await writeFile(
      resolve(import.meta.dir, "../test/fixtures/codex-terminal-recorded.json"),
      `${JSON.stringify(terminal, null, 2)}\n`,
    );
  }
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await driver.close().catch(() => {
    console.log(JSON.stringify({ code: "harness_cleanup_failed" }));
    process.exitCode = 1;
  });
  await rm(root, { recursive: true, force: true });
}
