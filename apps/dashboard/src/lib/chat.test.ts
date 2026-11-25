import { describe, expect, test } from "bun:test";
import {
  type ChatItem,
  chatTurnRunning,
  formatElapsedSeconds,
  projectChat,
  toolText,
  transcriptSignature,
} from "./chat.ts";
import { type ChatEvent, mergeEvents } from "./events.ts";
import { describeFailure } from "./failure.ts";

const turn = { conversationId: "c1", promptId: "p1" };
const prompt = (id: string, status: "queued" | "running" | "finished" | "failed" | "interrupted", extra = {}) =>
  ({ id, at: 1, kind: "prompt", text: "Fix the test", status, ...turn, ...extra }) as ChatEvent;
const chunk = (id: string, text: string, fields: Record<string, unknown>) =>
  ({ id, at: 2, kind: "message", text, partial: true, tools: [], ...turn, ...fields }) as ChatEvent;

const view = (items: ChatItem[]) =>
  items.map((item) =>
    item.kind === "assistant"
      ? `assistant:${item.text}${item.streaming ? "…" : ""}`
      : item.kind === "tool"
        ? `tool:${item.tool.name}`
        : item.kind === "outcome"
          ? `outcome:${item.status}`
          : `${item.kind}:${"text" in item ? item.text : ""}`,
  );

describe("chat projection", () => {
  test("streamed deltas and the final snapshot of one message show once, and replaying the pages changes nothing", () => {
    const stream: ChatEvent[] = [
      prompt("e1", "running"),
      chunk("e2", "All ", { messageId: "m1", textMode: "delta" }),
      chunk("e3", "green", { messageId: "m1", textMode: "delta" }),
    ];
    expect(view(projectChat(stream).items)).toEqual(["user:Fix the test", "assistant:All green…"]);

    const final = chunk("e4", "All green.", { messageId: "m1", textMode: "snapshot", partial: false });
    const done = prompt("e5", "finished");

    const pages = mergeEvents(mergeEvents(stream, [stream[2] as ChatEvent, final]), [final, done]);
    const chat = projectChat(pages);
    expect(view(chat.items)).toEqual(["user:Fix the test", "assistant:All green."]);
    expect(chat.running).toBe(false);

    expect(chat.items.map((item) => item.key)).toEqual(projectChat(stream).items.map((item) => item.key));
  });

  test("Claude's completed frames of one message (text, then a tool) keep the text and add the tool", () => {
    const chat = projectChat([
      chunk("a", "Checking ", { messageId: "msg_1", textMode: "delta" }),
      chunk("b", "Checking the parser.", { messageId: "msg_1", textMode: "snapshot", partial: false }),
      chunk("c", "Checking the parser.", {
        messageId: "msg_1",
        textMode: "snapshot",
        partial: false,
        tools: [{ id: "toolu_1", name: "Read", input: { file_path: "src/parser.ts" } }],
      }),
    ]);
    expect(view(chat.items)).toEqual(["assistant:Checking the parser.", "tool:Read"]);
  });

  test("distinct messages of a turn and the same message id in another turn stay apart", () => {
    const chat = projectChat([
      chunk("a", "First.", { messageId: "m1", textMode: "snapshot", partial: false }),
      chunk("b", "Second.", { messageId: "m2", textMode: "snapshot", partial: false }),
      chunk("c", "Other turn.", { messageId: "m1", textMode: "snapshot", partial: false, promptId: "p2" }),
    ]);
    expect(view(chat.items)).toEqual(["assistant:First.", "assistant:Second.", "assistant:Other turn."]);
  });

  test("legacy messages without identity stay separate; only streamed chunks give way to the final text", () => {
    const chat = projectChat([
      chunk("a", "Look", {}),
      chunk("b", "ing", {}),
      chunk("c", "Looking.", { partial: false }),
      chunk("d", "Done.", { partial: false }),
      chunk("e", "Still typ", {}),
    ]);
    expect(view(chat.items)).toEqual(["assistant:Looking.", "assistant:Done.", "assistant:Still typ…"]);
  });

  test("a tool call is one activity: the call, its input and its result correlate by id", () => {
    const chat = projectChat([
      chunk("a", "", { tools: [{ id: "t1", name: "Bash", input: {} }] }),
      chunk("b", "Running the tests.", {
        partial: false,
        model: "claude-opus-5-5",
        tools: [{ id: "t1", name: "Bash", input: { command: "bun test" } }],
      }),
      chunk("c", "", {
        partial: false,
        tools: [
          { id: "t1", name: "tool_result", result: { output: [{ type: "text", text: "1 fail" }], isError: true } },
        ],
      }),
    ]);
    expect(view(chat.items)).toEqual(["tool:Bash", "assistant:Running the tests."]);
    const tool = chat.items.find((item) => item.kind === "tool");
    expect(tool?.kind === "tool" && tool.tool).toMatchObject({
      name: "Bash",
      input: { command: "bun test" },
      result: { isError: true },
    });
    expect(tool?.kind === "tool" && toolText(tool.tool.result?.output)).toBe("1 fail");
    expect(chat.items.find((item) => item.kind === "assistant")).toMatchObject({ model: "claude-opus-5-5" });
  });

  test("one prompt is one user message with its latest status; a failure ends its turn with the reason", () => {
    const chat = projectChat([
      prompt("a", "queued", { conversationId: undefined }),
      prompt("b", "running"),
      chunk("c", "Trying.", { partial: false }),
      prompt("d", "failed", { reason: "usage_limit" }),
      { id: "x", at: 3, kind: "other", type: "rate_limits", data: {} },
    ]);
    expect(view(chat.items)).toEqual(["user:Fix the test", "assistant:Trying.", "outcome:failed"]);
    expect(chat.items.at(-1)).toMatchObject({ reason: "usage_limit" });
    expect(chat.technical.map((event) => event.id)).toEqual(["x"]);
    expect(projectChat([prompt("a", "running")]).running).toBe(true);
  });

  test("a finished turn with an expired-credential event fails and points to the Harness page", () => {
    const chat = projectChat([
      prompt("a", "running"),
      { id: "x", at: 2, kind: "other", type: "auth_expiry", data: { message: "OAuth token expired" }, ...turn },
      prompt("b", "finished"),
    ]);
    expect(view(chat.items)).toEqual(["user:Fix the test", "outcome:failed"]);
    const outcome = chat.items.at(-1);
    expect(describeFailure(outcome?.kind === "outcome" ? outcome.reason : null)).toMatchObject({
      title: "Account expired",
      fix: { href: "/harness" },
    });
  });

  test("historical status does not override the current conversation's transcript state", () => {
    expect(chatTurnRunning({ state: "running", conversationId: "old" }, "current", false)).toBe(false);
    expect(chatTurnRunning({ state: "finished", conversationId: "old" }, "current", true)).toBe(true);
    expect(chatTurnRunning({ state: "running", conversationId: "current" }, "current", false)).toBe(true);
  });

  test("historical prompts stay visible without marking the current conversation as running", () => {
    const chat = projectChat(
      [
        prompt("old", "running", { text: "Historical prompt" }),
        prompt("current", "finished", { conversationId: "c2", promptId: "p2", text: "Current prompt" }),
      ],
      "c2",
    );
    expect(view(chat.items)).toEqual(["user:Historical prompt", "user:Current prompt"]);
    expect(chat.running).toBe(false);
  });

  test("transcriptSignature tracks in-place tool updates and formatElapsedSeconds handles all ranges", () => {
    const t = (id: string, extra: Record<string, unknown> = {}) =>
      ({
        kind: "tool",
        key: `tool:${id}`,
        at: 1000,
        tool: { id, name: "Bash", at: 1000, ...extra },
      }) satisfies ChatItem;
    const t2 = t("t2", { name: "Read" });
    const variants = [
      {},
      { input: { command: "ls" } },
      { input: { command: "ls" }, result: { output: "ok", isError: false } },
      { input: { command: "ls" }, result: { output: "ok", isError: true } },
    ];
    expect(new Set(variants.map((v) => transcriptSignature([t("t1", v), t2], true))).size).toBe(4);
    expect([9_500, 22_900, 75_000, 3_730_000].map((now) => formatElapsedSeconds(10_000, now))).toEqual([
      "0s",
      "12s",
      "1m 05s",
      "1h 02m",
    ]);
    expect([formatElapsedSeconds(0, 10_000), formatElapsedSeconds(Number.NaN, 10_000)]).toEqual([null, null]);
  });
});
