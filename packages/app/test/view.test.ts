import { expect, test } from "bun:test";
import type { ChatItem } from "@armada/protocol";
import { refusal, summarizeWork, workDuration, workIcon, workLabel, workRows } from "../src/room/view";

// The coordinator's work as T3 Code's rows (THE-2053): the pure rules on
// synthetic tool calls. Thread's markup and clicks are test/work-rows.test.tsx.

const AT = "2026-03-10T09:00:00.000Z";
const at = (second: number) => new Date(Date.parse(AT) + second * 1000).toISOString();
type Tool = Extract<ChatItem, { kind: "tool" }>;
const call = (id: string, name: string, input: Tool["input"] = {}, extra: Partial<Tool> = {}): Tool => ({
  kind: "tool",
  id,
  at: AT,
  name,
  input,
  output: '{"ok":true}',
  failed: false,
  ...extra,
});

test("a tool call's sentence comes from its name and input", () => {
  const cases: [string, Tool["input"], string][] = [
    ["fleet.status", {}, "Read the fleet"],
    ["inbox.list", {}, "Read the inbox"],
    ["inbox.answer", { id: "i-1", answer: "yes" }, "Answered an inbox item"],
    ["worker.launch", { ticket: "THE-12" }, "Launched THE-12"],
    ["worker.relaunch", { ticket: "THE-12", reason: "stuck" }, "Relaunched THE-12"],
    ["worker.message", { ticket: "THE-12", message: "rebase" }, "Messaged THE-12's worker"],
    ["worker.stop", { ticket: "THE-12", reason: "done" }, "Stopped THE-12's worker"],
    ["merge.check", { pr: 34 }, "Checked #34"],
    ["merge.run", { pr: 34 }, "Merged #34"],
    ["hold.add", { reason: "red main" }, "Paused merges"],
    ["hold.clear", { id: "h-1", reason: "green" }, "Cleared a merge pause"],
    ["owner.ask", { ticket: "THE-12", question: "Which?", choices: [] }, "Asked you about THE-12"],
    ["rules.set", {}, "Changed the rules"],
    ["ticket.read", { ticket: "THE-12" }, "Read THE-12"],
    ["deploy.watch", {}, "Used deploy.watch"],
    // Input the model got wrong still reads as a sentence.
    ["worker.launch", { ticket: "  " }, "Launched a worker"],
    ["merge.run", "34", "Merged a pull request"],
  ];
  expect(cases.map(([name, input]) => workLabel(call("t", name, input)))).toEqual(cases.map(([, , label]) => label));
  expect(
    ["fleet.status", "inbox.list", "ticket.read", "worker.launch", "worker.relaunch", "worker.message"].map(workIcon),
  ).toEqual(["eye", "eye", "file", "rocket", "rocket", "message"]);
  expect(["worker.stop", "merge.run", "owner.ask", "rules.set", "hold.add", "inbox.answer"].map(workIcon)).toEqual([
    "square",
    "merge",
    "help",
    "sliders",
    "wrench",
    "wrench",
  ]);
});

test("a group's sentence names at most two kinds, changes first, in the order they came, and counts the rest", () => {
  const read = (id: string) => call(id, "fleet.status");
  const launch = (id: string) => call(id, "worker.launch", { ticket: "THE-12" });
  expect(summarizeWork([read("a"), launch("b"), read("c"), launch("d"), read("e")])).toEqual({
    summary: "Read the fleet 3 times and launched 2 workers",
    failed: false,
  });
  expect(summarizeWork([launch("a")]).summary).toBe("Launched 1 worker");
  expect(summarizeWork([read("a"), read("b")]).summary).toBe("Read the fleet 2 times");
  // Three kinds: the reads give way to the two changes, the read is counted.
  const merge = call("m", "merge.run", { pr: 34 });
  expect(summarizeWork([read("a"), launch("b"), merge]).summary).toBe(
    "Launched 1 worker, merged 1 pull request and 1 other action",
  );
  const many = [read("a"), launch("b"), merge, call("x", "inbox.list"), call("y", "deploy.watch")];
  expect(summarizeWork(many).summary).toBe("Launched 1 worker, merged 1 pull request and 3 other actions");
  // A failure anywhere marks the group.
  expect(summarizeWork([read("a"), { ...launch("b"), failed: true }]).failed).toBe(true);
});

test("a turn's length reads 12s, 2m 03s, 1h 04m", () => {
  expect(workDuration(0)).toBe("1s");
  expect(workDuration(12_400)).toBe("12s");
  expect(workDuration(123_000)).toBe("2m 03s");
  expect(workDuration(59_600)).toBe("1m 00s");
  expect(workDuration(3_840_000)).toBe("1h 04m");
  expect(workDuration(Number.NaN)).toBe("1s");
});

test("a turn's calls are one row where its first came, folded above the answer or the line that ends it", () => {
  const items: ChatItem[] = [
    { kind: "owner", id: "o1", at: at(0), body: "Launch THE-12" },
    call("t1", "fleet.status", {}, { at: at(1) }),
    call("t2", "worker.launch", { ticket: "THE-12" }, { at: at(3) }),
    { kind: "coordinator", id: "c1", at: at(124), body: "Launched." },
    { kind: "owner", id: "o2", at: at(200), body: "Stop" },
    call("t3", "worker.stop", { ticket: "THE-12", reason: "owner" }, { at: at(201) }),
    { kind: "coordinator", id: "c2", at: at(205), body: "", aborted: true },
    // Two turns the coordinator ran on fleet notices, an hour apart: each line ends its own.
    call("t4", "fleet.status", {}, { at: at(300) }),
    { kind: "line", id: "l1", at: at(312), body: "THE-9 merged." },
    call("t5", "fleet.status", {}, { at: at(3900) }),
    { kind: "line", id: "l2", at: at(3905), body: "THE-12 is red." },
    call("t6", "fleet.status", {}, { at: at(4000) }),
    { kind: "owner", id: "o3", at: at(4001), body: "And?" },
    { kind: "line", id: "l3", at: at(4002), body: "THE-14 is green." },
    call("t7", "inbox.list", {}, { at: at(4003) }),
  ];
  const rows = workRows(items).map((r) =>
    r.kind === "said"
      ? r.item.id
      : `${r.kind}:${r.work.tools.map((t) => t.id).join("+")}${r.kind === "fold" ? ` ${r.label}` : ""}`,
  );
  expect(rows).toEqual([
    "o1",
    "fold:t1+t2 Worked for 2m 03s",
    "c1",
    "o2",
    "fold:t3 You stopped this response",
    "c2",
    "fold:t4 Worked for 12s",
    "l1",
    "fold:t5 Worked for 5s",
    "l2",
    // Work an owner message cut off stays open; so does the newest turn's.
    "work:t6",
    "o3",
    "l3",
    "work:t7",
  ]);
  // The row keeps its key while its turn grows and folds.
  expect(workRows(items.slice(0, 2))[1]?.id).toBe("work:t1");
  expect(workRows(items)[1]?.id).toBe("work:t1");
});

test("a refused call says the refusal's message; another failure and a success say nothing", () => {
  const refused = call("t", "hold.add", { reason: " " }, { output: '{"ok":false,"message":"say why"}', failed: true });
  expect(refusal(refused)).toBe("say why");
  expect(refusal({ ...refused, output: "boom" })).toBeNull();
  expect(refusal({ ...refused, failed: false })).toBeNull();
  expect(refusal({ ...refused, output: null })).toBeNull();
});
