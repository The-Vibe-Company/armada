import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readCodexModels } from "../src/codex-models.ts";

function catalog() {
  const sent: { id?: number; method: string; params?: Record<string, unknown> }[] = [];
  const kills: (NodeJS.Signals | number | undefined)[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: (signal?: NodeJS.Signals | number) => {
      kills.push(signal);
      return true;
    },
  });
  let expire = () => {};
  let cancelled = false;
  child.stdin.on("data", (chunk) => sent.push(JSON.parse(chunk.toString())));
  const result = readCodexModels("/work/widgets", {
    start: (cwd) => {
      expect(cwd).toBe("/work/widgets");
      return child;
    },
    deadline: (callback) => {
      expire = callback;
      return () => {
        cancelled = true;
      };
    },
  });
  const reply = (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`);
  return { child, sent, kills, result, reply, expire: () => expire(), cancelled: () => cancelled };
}

test("Codex catalog initializes, follows pages, returns exact model IDs and kills the child without a thread", async () => {
  const t = catalog();
  expect(t.sent.map((m) => m.method)).toEqual(["initialize"]);
  expect(t.sent[0]?.params?.capabilities).toEqual({ explicitGatewayOAuth: true });
  t.reply({ id: 99, result: { data: [{ model: "ignored" }] } });
  t.child.stdout.write('{"id":0,"result":');
  t.child.stdout.write('{"userAgent":"CANARY"}}\n');
  expect(t.sent.map((m) => m.method)).toEqual(["initialize", "initialized", "model/list"]);
  expect(t.sent[2]?.params).toEqual({ limit: 100, includeHidden: true, cursor: null });
  t.reply({ method: "diagnostic", params: { token: "CANARY" } });
  t.reply({
    id: 1,
    result: { data: [{ id: "picker-id", model: "gpt-example", description: "CANARY" }], nextCursor: "page-two" },
  });
  expect(t.sent[3]?.params?.cursor).toBe("page-two");
  t.reply({
    id: 2,
    result: { data: [{ model: "gpt-example" }, { model: "gpt-other", hidden: true }], nextCursor: null },
  });
  expect(await t.result).toEqual(["gpt-example", "gpt-other"]);
  expect(t.kills).toEqual(["SIGKILL"]);
  expect(t.child.stdin.destroyed).toBe(true);
  expect(t.cancelled()).toBe(true);
  expect(t.sent.every((m) => ["initialize", "initialized", "model/list"].includes(m.method))).toBe(true);
});

test("Codex catalog discards incomplete, malformed, looping, failed and oversized results", async () => {
  for (const mode of [
    "error",
    "stdin-error",
    "close",
    "deadline",
    "json",
    "rpc-error",
    "data",
    "model",
    "cursor",
    "loop",
    "oversized",
  ]) {
    const t = catalog();
    t.reply({ id: 0, result: {} });
    if (mode === "error") t.child.emit("error", new Error("CANARY"));
    if (mode === "stdin-error") t.child.stdin.emit("error", new Error("CANARY"));
    if (mode === "close") t.child.emit("close", 1);
    if (mode === "deadline") t.expire();
    if (mode === "json") t.child.stdout.write("not json CANARY\n");
    if (mode === "rpc-error") t.reply({ id: 1, error: { message: "CANARY" } });
    if (mode === "data") t.reply({ id: 1, result: { data: {} } });
    if (mode === "model") t.reply({ id: 1, result: { data: [{ model: "bad\nCANARY" }] } });
    if (mode === "cursor") t.reply({ id: 1, result: { data: [], nextCursor: 1 } });
    if (mode === "loop") {
      t.reply({ id: 1, result: { data: [{ model: "gpt-example" }], nextCursor: "repeat" } });
      t.reply({ id: 2, result: { data: [], nextCursor: "repeat" } });
    }
    if (mode === "oversized") t.child.stdout.write("x".repeat(1_048_577));
    expect(await t.result).toBeNull();
    expect(t.kills).toEqual(["SIGKILL"]);
    expect(t.cancelled()).toBe(true);
  }
  expect(
    await readCodexModels("/work/widgets", {
      start: () => {
        throw new Error("CANARY");
      },
      deadline: () => () => {},
    }),
  ).toBeNull();
});

test("a successful empty Codex catalog remains distinguishable from an unavailable catalog", async () => {
  const t = catalog();
  t.reply({ id: 0, result: {} });
  t.reply({ id: 1, result: { data: [], nextCursor: null } });
  expect(await t.result).toEqual([]);
});

test("Codex catalog preserves control-safe custom model identifiers", async () => {
  const t = catalog();
  const models = ["provider/model[large]", "provider/modèle@2026", `gpt-${"x".repeat(300)}`];
  t.reply({ id: 0, result: {} });
  t.reply({ id: 1, result: { data: models.map((model) => ({ model })), nextCursor: null } });
  expect(await t.result).toEqual(models);
});
