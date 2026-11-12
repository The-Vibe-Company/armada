import { describe, expect, test } from "bun:test";
import { createScopedProbe, type ScopedProbeIo } from "./scoped-access-smoke.ts";

// This boundary owns the deployed smoke oracle, not gateway behavior: recorded
// native wire events must prove effects, and owner cleanup must distrust model IDs.
const parent = "10000000-0000-4000-8000-000000000001";
const child = "10000000-0000-4000-8000-000000000002";
const other = "10000000-0000-4000-8000-000000000003";
const operation = "20000000-0000-4000-8000-000000000001";
const item = {
  org: "test-org",
  provider: "boat" as const,
  harness: "codex" as const,
  goldenId: "30000000-0000-4000-8000-000000000001",
  modelAccountId: "40000000-0000-4000-8000-000000000001",
  model: "test-model",
  reasoningEffort: "low",
};
type Obj = Record<string, unknown>;
function at<T>(values: T[], index = 0): T {
  const value = values[index];
  if (value === undefined) throw new Error("Missing wire fixture entry");
  return value;
}
type WireTool = { id: string; name: string; input: Obj; result: { output: unknown; isError: boolean } };
function fixture(enabled = true) {
  const output: Obj[] = [];
  const stopped: string[] = [];
  const requests: { path: string; body: Obj }[] = [];
  const state = {
    before: [] as string[],
    after: [parent, child],
    tools: [] as WireTool[],
    events: [] as Obj[],
    sends: 0,
    lists: 0,
    logReads: 0,
    noTools: false,
    denied: false,
    content: false,
    genericFailure: false,
    eventTurn: "turn",
    retracted: false,
    sendUnknown: false,
    notReady: false,
    logsFail: false,
    waitRunning: false,
    logsIncomplete: false,
    listPages: 1,
    incomplete: false,
    stopFail: new Set<string>(),
    mutate: (_tools: WireTool[]) => {},
  };
  const receipt = (sandboxId = child) => ({ id: operation, sandboxId, state: "succeeded" });
  const wire = (name: string, input: Obj, result: Obj, suffix = name): WireTool => ({
    id: suffix,
    name,
    input,
    result: {
      isError: false,
      output: state.content
        ? { content: [{ type: "text", text: JSON.stringify({ result }) }], structuredContent: null, _meta: null }
        : { structuredContent: { result } },
    },
  });
  const io: ScopedProbeIo = {
    async request<T>(path: string, input: object): Promise<T> {
      const body = input as Obj;
      requests.push({ path, body });
      expect(body.org).toBe(item.org);
      if (path === "sandbox/list") {
        expect(body.owner).toBe("me");
        expect(body.golden).toBe(item.goldenId);
        expect(body.limit).toBe(200);
        const first = state.lists === 0;
        const page = body.page as number;
        const hasMore = state.incomplete || page < state.listPages;
        if (!hasMore) state.lists++;
        return {
          sandboxes: (first ? state.before : state.after).map((id) => ({ id })),
          hasMore,
          nextPage: hasMore ? page + 1 : null,
        } as T;
      }
      if (path === "sandbox/send") {
        state.sends++;
        if (state.notReady && state.sends === 1) throw new Error("not_ready");
        expect(body.id).toBe(parent);
        const goal = body.prompt as string;
        const launch = JSON.parse(goal.match(/using exactly (.*?) \(no initial/)?.[1] ?? "null") as Obj;
        const message = JSON.parse(
          goal.match(/message that child's returned sandboxId with exactly (.*?), replacing CHILD_SANDBOX_ID/)?.[1] ??
            "null",
        ) as Obj;
        // The instructions must supply the required target, not rely on the model
        // repairing a payload the smoke calls exact. Substitute only the returned ID.
        expect(message.sandboxId).toBe("CHILD_SANDBOX_ID");
        const stopKey = goal.match(/Then stop that same child using idempotencyKey ([\w-]+)\./)?.[1];
        const answer = goal.match(/SCOPED_CHILD_[\w-]+/)?.[0];
        const marker = goal.match(/NO_ACCESS_[\w-]+/)?.[0];
        // Independent schema assertions: no owner token/REST shortcut, no launch prompt/TTL.
        expect(Object.keys(launch).sort()).toEqual(["idempotencyKey", "selection"]);
        expect(launch.selection).toEqual({
          goldenId: item.goldenId,
          harness: "codex",
          credentialId: item.modelAccountId,
          credentialVersion: 7,
          model: item.model,
          reasoningEffort: "low",
          skills: [],
        });
        const tools = state.noTools
          ? []
          : [
              wire("launch", launch, receipt()),
              wire("message", { ...message, sandboxId: child }, receipt()),
              wire(
                "read",
                { sandboxId: child },
                {
                  id: child,
                  orgId: item.org,
                  provider: item.provider,
                  harness: "codex",
                  goldenId: item.goldenId,
                  credentialId: item.modelAccountId,
                  credentialVersion: 7,
                  model: item.model,
                  reasoningEffort: item.reasoningEffort,
                  events: [
                    {
                      id: "child-answer",
                      kind: "message",
                      responseKind: "assistant",
                      text: answer,
                      partial: false,
                      tools: [],
                    },
                  ],
                },
              ),
              wire("stop", { idempotencyKey: stopKey, sandboxId: child }, receipt()),
            ];
        if (state.denied || state.genericFailure) {
          tools.splice(1);
          at(tools, 0).result = {
            isError: false,
            output: {
              isError: true,
              content: [
                { type: "text", text: state.denied ? "scoped_authority_denied" : "scoped_operation_unavailable" },
              ],
            },
          };
        }
        state.mutate(tools);
        state.tools = tools;
        state.events = [
          {
            id: "native",
            promptId: state.eventTurn,
            retracted: state.retracted,
            kind: "message",
            text: marker,
            partial: false,
            tools,
          },
        ];
        if (state.sendUnknown) throw new Error("sensitive-network-error-do-not-print");
        return { promptId: "turn" } as T;
      }
      if (path === "sandbox/wait") {
        expect(body).toEqual({ org: item.org, id: parent, prompt_id: "turn", timeout_seconds: 0 });
        return { prompt: { promptId: "turn", state: state.waitRunning ? "running" : "finished" } } as T;
      }
      if (path === "logs/read") {
        state.logReads++;
        expect(body.id).toBe(parent);
        expect(body.coalesce).toBe(true);
        expect(body.maxBytes).toBe(1_048_576);
        expect(body.limit).toBe(500);
        if (state.logsFail) throw new Error("secret-error-do-not-print");
        return {
          events: state.events,
          hasMore: state.logsIncomplete,
          cursor: state.logsIncomplete ? `cursor-${state.logReads}` : null,
        } as T;
      }
      throw new Error(`Unexpected route ${path}`);
    },
    async poll<T>(read: () => Promise<T>, done: (result: T) => boolean) {
      for (let n = 0; n < 3; n++) {
        const result = await read();
        if (done(result)) return result;
      }
      throw new Error("poll exhausted");
    },
    step: async (_name, action) => action(),
    withCleanup: async (action) => action(),
    async stopSandbox(id) {
      stopped.push(id);
      if (state.stopFail.has(id)) throw new Error("safe stop failed");
    },
    isNotReady: (error) => error instanceof Error && error.message === "not_ready",
    out: (line) => output.push(JSON.parse(line)),
  };
  const probe = createScopedProbe(item, enabled, io);
  return { probe, state, output, stopped, requests, wire, receipt };
}
async function run(f: ReturnType<typeof fixture>) {
  await f.probe.prepare();
  return f.probe.run(parent, 7);
}

describe("ordinary scoped Armada smoke", () => {
  test.each([false, true])(
    "proves launch, one child turn, actual answer, stop and physical cleanup (content=%s)",
    async (content) => {
      const f = fixture();
      f.state.content = content;
      f.state.notReady = true;
      f.state.listPages = 2;
      await run(f);
      expect(await f.probe.cleanup(parent, true)).toBe(true);
      expect(f.stopped).toEqual([child]);
      expect(f.state.sends).toBe(2); // Only the closed pre-admission not-ready rejection is retried.
      expect(f.output[0]).toMatchObject({
        pass: true,
        parentId: parent,
        operationIds: [operation],
        claimedSandboxIds: [child],
      });
    },
  );

  test.each(["noTools", "denied"] as const)(
    "negative control accepts only genuine lack of authority: %s",
    async (mode) => {
      const f = fixture(false);
      f.state[mode] = true;
      f.state.after = [parent];
      await run(f);
      expect(await f.probe.cleanup(parent, true)).toBe(true);
      expect(f.stopped).toEqual([]);
    },
  );

  test("negative control recognizes the native Codex error message envelope", async () => {
    const f = fixture(false);
    f.state.denied = true;
    f.state.after = [parent];
    f.state.mutate = (tools) => {
      at(tools, 0).result = { isError: true, output: { message: "scoped_authority_denied" } };
    };
    await run(f);
    expect(await f.probe.cleanup(parent, true)).toBe(true);
  });

  test.each(["success", "generic", "wrong-selection", "wrong-args", "wrong-marker"])(
    "negative control rejects %s",
    async (mode) => {
      const f = fixture(false);
      if (mode !== "success") f.state.denied = true;
      if (mode === "generic") {
        f.state.denied = false;
        f.state.genericFailure = true;
      }
      if (mode === "wrong-selection")
        f.state.mutate = (tools) => {
          (at(tools, 0).input.selection as Obj).credentialId = other;
        };
      if (mode === "wrong-args")
        f.state.mutate = (tools) => {
          at(tools, 0).input.prompt = "extra";
        };
      if (mode === "wrong-marker") f.state.retracted = true;
      await expect(run(f)).rejects.toThrow(mode === "success" ? "scoped_negative_effect" : "scoped_negative_unproven");
    },
  );

  test.each([
    "missing-message",
    "missing-read",
    "missing-stop",
    "wrong-id",
    "echo",
    "partial",
    "tool-result",
    "nested-error",
    "wrong-turn",
    "reordered",
    "exec-fallback",
    "wrong-binding",
    "wrong-model",
    "wrong-effort",
    "rebound-call",
    "orphan-result",
    "retracted-tools",
  ])("positive requires correlated native evidence: %s", async (mode) => {
    const f = fixture();
    f.state.mutate = (tools) => {
      if (mode.startsWith("missing-"))
        tools.splice(
          tools.findIndex((tool) => tool.name === mode.slice(8)),
          1,
        );
      if (mode === "wrong-id") at(tools, 1).input.sandboxId = other;
      if (["echo", "partial", "tool-result"].includes(mode)) {
        const result = (at(tools, 2).result.output as { structuredContent: { result: { events: Obj[] } } })
          .structuredContent.result;
        const event = at(result.events);
        if (mode === "echo") event.kind = "prompt";
        if (mode === "partial") event.partial = true;
        if (mode === "tool-result") event.responseKind = "tool_result";
      }
      if (mode === "nested-error") (at(tools, 2).result.output as Obj).isError = true;
      if (mode === "wrong-turn") f.state.eventTurn = "another-turn";
      if (mode === "reordered") tools.reverse();
      if (mode === "exec-fallback") tools.push(f.wire("exec_command", {}, {}));
      if (mode === "wrong-binding")
        (at(tools, 2).result.output as { structuredContent: { result: Obj } }).structuredContent.result.credentialId =
          other;
      if (mode === "wrong-model" || mode === "wrong-effort")
        (at(tools, 2).result.output as { structuredContent: { result: Obj } }).structuredContent.result[
          mode === "wrong-model" ? "model" : "reasoningEffort"
        ] = "wrong";
      if (mode === "rebound-call")
        tools.unshift({ ...at(tools), name: "commandExecution", input: { command: "unsafe" } });
      if (mode === "orphan-result") tools.push(f.wire("tool_result", {}, {}));
      if (mode === "retracted-tools") f.state.retracted = true;
    };
    await expect(run(f)).rejects.toThrow("scoped_");
  });

  test.each([true, false])("rejects non-MCP native actions in either control (enabled=%s)", async (enabled) => {
    const f = fixture(enabled);
    if (!enabled) f.state.noTools = true;
    const request = f.probe.run.bind(f.probe);
    await f.probe.prepare();
    const running = request(parent, 7);
    // Events are returned by reference in this wire fixture; inject the normalized
    // provider action before the awaited send receipt continues.
    f.state.events.push({
      id: "side-effect",
      promptId: "turn",
      kind: "other",
      type: "item/completed",
      data: { item: { type: "fileChange" } },
    });
    await expect(running).rejects.toThrow("scoped_unapproved_native_action");
  });

  test("unknown parent allocation cannot report a clean scoped inventory", async () => {
    const f = fixture();
    f.state.after = [];
    await f.probe.prepare();
    expect(await f.probe.cleanup(undefined, false, true)).toBe(false);
    expect(f.output.at(-1)).toMatchObject({
      step: "scoped_cleanup_summary",
      pass: false,
      unknownParent: true,
      unknownFutureChildren: true,
    });
  });

  test.each([true, false])(
    "nonsecret reference reading is permitted without substituting for scoped proof: %s",
    async (enabled) => {
      const f = fixture(enabled);
      if (!enabled) {
        f.state.noTools = true;
        f.state.after = [parent];
      }
      f.state.mutate = (tools) =>
        tools.unshift(
          f.wire(
            "commandExecution",
            { command: "/bin/bash -lc 'cat /home/user/.agents/skills/armada-tools/SKILL.md'" },
            {},
            "reference",
          ),
        );
      await run(f);
      expect(await f.probe.cleanup(parent, true)).toBe(true);
    },
  );

  test("deduplicates native tool updates rather than treating them as two launches", async () => {
    const f = fixture();
    f.state.mutate = (tools) => {
      tools.unshift({ ...at(tools, 0), result: undefined } as unknown as WireTool);
    };
    await run(f);
    expect(await f.probe.cleanup(parent, true)).toBe(true);
  });

  test("unknown parent send is never replayed and late receipts are safely adopted after quiescence", async () => {
    const f = fixture();
    f.state.sendUnknown = true;
    await expect(run(f)).rejects.toThrow("sensitive-network-error");
    expect(f.state.sends).toBe(1);
    expect(await f.probe.cleanup(parent, true)).toBe(false);
    expect(f.stopped).toEqual([child]);
    expect(f.output[0]).toMatchObject({
      parentId: parent,
      unknownSend: true,
      operationIds: [operation],
      claimedSandboxIds: [child],
    });
    expect(JSON.stringify(f.output)).not.toContain("sensitive-network-error");
  });

  test("uncertain launch retains the local key, operation and safe cleanup identity without replay", async () => {
    const f = fixture();
    f.state.mutate = (tools) => {
      const result = (at(tools, 0).result.output as { structuredContent: { result: Obj } }).structuredContent.result;
      result.state = "uncertain";
      tools.splice(1);
    };
    await expect(run(f)).rejects.toThrow("scoped_launch_unproven");
    expect(await f.probe.cleanup(parent, true)).toBe(false);
    expect(f.stopped).toEqual([child]);
    expect(f.state.sends).toBe(1);
    expect(f.output[0]).toMatchObject({ unknownLaunch: true, operationIds: [operation], claimedSandboxIds: [child] });
    expect(f.output[0]?.launchRequestKey).toMatch(/^smoke-scoped-/);
  });

  test.each(["preexisting", "unmatched", "unclaimed", "parent"])("cleanup never stops unsafe IDs: %s", async (mode) => {
    const f = fixture();
    if (mode === "preexisting") f.state.before = [child];
    if (mode === "unmatched") f.state.after = [parent, other];
    if (mode === "unclaimed") {
      f.state.noTools = true;
    }
    if (mode === "parent")
      f.state.mutate = (tools) => {
        (at(tools, 0).result.output as { structuredContent: { result: Obj } }).structuredContent.result.sandboxId =
          parent;
      };
    await run(f).catch(() => {});
    expect(await f.probe.cleanup(parent, true)).toBe(false);
    expect(f.stopped).toEqual([]);
    expect(f.output[0]?.pass).toBe(false);
  });

  test("cleanup attempts every corroborated claim despite a stop failure", async () => {
    const f = fixture();
    f.state.after.push(other);
    f.state.stopFail.add(child);
    await run(f);
    // Parent was quiesced; a late update of its local launch receipt is retained too.
    const launch = at(f.state.tools);
    const late = structuredClone(launch);
    late.id = "late";
    (late.result.output as { structuredContent: { result: Obj } }).structuredContent.result.sandboxId = other;
    f.state.tools.push(late);
    expect(await f.probe.cleanup(parent, true)).toBe(false);
    expect(f.stopped).toEqual([child, other]);
    expect(f.output[0]).toMatchObject({ leftoverSandboxIds: [child], claimedSandboxIds: [child, other] });
  });

  test("malformed local-key selection still preserves known cleanup receipts, without accepting it as proof", async () => {
    const f = fixture();
    f.state.mutate = (tools) => {
      (at(tools).input.selection as Obj).credentialId = other;
    };
    await expect(run(f)).rejects.toThrow("scoped_launch_unproven");
    expect(await f.probe.cleanup(parent, true)).toBe(true);
    expect(f.stopped).toEqual([child]);
    expect(f.output[0]).toMatchObject({ operationIds: [operation], claimedSandboxIds: [child] });
  });

  test("excessively nested MCP output cannot bypass the bounded evidence parser", async () => {
    const f = fixture();
    f.state.mutate = (tools) => {
      let output = at(tools).result.output;
      for (let n = 0; n < 8; n++) output = { structuredContent: output };
      at(tools).result.output = output;
    };
    await expect(run(f)).rejects.toThrow("scoped_launch_unproven");
    expect(await f.probe.cleanup(parent, true)).toBe(false);
    expect(f.stopped).toEqual([]);
  });

  test.each(["missing-receipt", "missing-operation"])(
    "unknown launch does not authorize stopping unclaimed allocations: %s",
    async (mode) => {
      const f = fixture();
      f.state.mutate = (tools) => {
        if (mode === "missing-receipt") at(tools).result.output = null;
        else
          (at(tools).result.output as { structuredContent: { result: Obj } }).structuredContent.result.id =
            "not-an-operation";
        tools.splice(1);
      };
      await expect(run(f)).rejects.toThrow("scoped_launch_unproven");
      expect(await f.probe.cleanup(parent, true)).toBe(false);
      expect(f.stopped).toEqual([]);
      expect(f.output[0]).toMatchObject({ unattributedSandboxIds: [child], claimedSandboxIds: [] });
      if (mode === "missing-receipt") expect(f.output[0]?.unknownLaunch).toBe(true);
    },
  );

  test("bounded log pagination cannot turn incomplete evidence into a passing probe", async () => {
    const f = fixture();
    f.state.logsIncomplete = true;
    await expect(run(f)).rejects.toThrow("scoped_incomplete_logs");
    expect(f.state.logReads).toBe(20);
    expect(await f.probe.cleanup(parent, true)).toBe(false);
    expect(f.state.logReads).toBe(40);
    expect(f.stopped).toEqual([child]); // Complete individual receipt remains safe despite incomplete overall evidence.
    expect(f.output[0]).toMatchObject({ unknownEvidence: true });
  });

  test("an unquiesced parent cannot produce a falsely final clean child inventory", async () => {
    const f = fixture();
    f.state.noTools = true;
    f.state.after = [parent];
    f.state.waitRunning = true;
    await expect(run(f)).rejects.toThrow("poll exhausted");
    expect(await f.probe.cleanup(parent, false)).toBe(false);
    expect(f.stopped).toEqual([]);
    expect(f.output[0]).toMatchObject({
      pass: false,
      parentId: parent,
      unknownParent: true,
      unknownFutureChildren: true,
    });
    expect(f.output[0]?.launchRequestKey).toMatch(/^smoke-scoped-/);
  });

  test("snapshot must complete before any native compute; unreadable evidence never becomes cleanup authority", async () => {
    const f = fixture();
    f.state.incomplete = true;
    await expect(f.probe.prepare()).rejects.toThrow("scoped_incomplete_snapshot");
    await expect(f.probe.run(parent, 7)).rejects.toThrow("scoped_not_prepared");
    expect(f.state.sends).toBe(0);
    const g = fixture();
    g.state.logsFail = true;
    await expect(run(g)).rejects.toThrow("secret-error");
    expect(await g.probe.cleanup(parent, true)).toBe(false);
    expect(g.stopped).toEqual([]);
    expect(g.output[0]).toMatchObject({ unknownEvidence: true, unattributedSandboxIds: [child] });
    expect(JSON.stringify(g.output)).not.toContain("secret-error");
  });
});
