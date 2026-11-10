import { expect, test } from "bun:test";
import type { AgentEvent } from "../src/provider.ts";
import { turnModelEvidence } from "../src/turn-model.ts";
import recording from "./fixtures/boat-claude-fable-recording.json";

const message = (model: string | undefined, extra: Record<string, unknown> = {}): AgentEvent => ({
  id: "response",
  at: 1,
  promptId: "turn",
  kind: "message",
  text: "",
  partial: false,
  tools: [],
  ...(model ? { model } : {}),
  ...extra,
});

// Actual redacted `armada logs 8c26ce84 --all --json`, supplied by the coordinator.
// The selection belongs to the launch request, not to a field invented in the log fixture.
test("production recording retains the observed response and identifies the selection mismatch", () => {
  const evidence = turnModelEvidence(recording.events as AgentEvent[], {
    promptId: "5f58f2cc-d440-4897-a485-4be6e653df6b",
    requestedModel: "claude-fable-5-2",
    complete: !recording.hasMore,
  });
  expect(evidence).toMatchObject({
    requestedModel: "claude-fable-5-2",
    observedModel: "claude-sonnet-5",
    modelSelectionReason: "model_selection_mismatch",
  });
  expect(evidence.modelSelectionMessage).toContain("Work may already have occurred");
  expect(evidence.modelSelectionMessage).toContain("Do not retry automatically");
});

test.each([
  { name: "matched response", events: [message("chosen")], complete: true, reason: null, observed: "chosen" },
  {
    name: "missing model",
    events: [message(undefined)],
    complete: true,
    reason: "model_selection_unverified",
    observed: null,
  },
  {
    name: "truncated history",
    events: [message("chosen")],
    complete: false,
    reason: "model_selection_unverified",
    observed: "chosen",
  },
  {
    name: "partial only",
    events: [message("chosen", { partial: true })],
    complete: true,
    reason: "model_selection_unverified",
    observed: null,
  },
  {
    name: "subagent only",
    events: [message("different", { parentToolUseId: "tool" })],
    complete: true,
    reason: "model_selection_unverified",
    observed: null,
  },
  {
    name: "retracted response",
    events: [message("chosen"), message("chosen", { retracted: true })],
    complete: true,
    reason: "model_selection_unverified",
    observed: null,
  },
  {
    name: "subagent fallback does not replace root",
    events: [message("chosen"), message("different", { id: "child", parentToolUseId: "tool" })],
    complete: true,
    reason: null,
    observed: "chosen",
  },
  {
    name: "historical turn cannot replace target",
    events: [message("chosen"), message("different", { id: "old", promptId: "old" })],
    complete: true,
    reason: null,
    observed: "chosen",
  },
  {
    name: "multiple root models are not a last-event model",
    events: [message("chosen"), message("different", { id: "second" })],
    complete: true,
    reason: "model_selection_unverified",
    observed: null,
  },
])("$name", ({ events, complete, reason, observed }) => {
  expect(turnModelEvidence(events, { promptId: "turn", requestedModel: "chosen", complete })).toMatchObject({
    observedModel: observed,
    modelSelectionReason: reason,
  });
});

test("tool results do not invalidate a verified assistant response", () => {
  expect(
    turnModelEvidence([message("chosen"), message(undefined, { id: "tool", responseKind: "tool_result" })], {
      promptId: "turn",
      requestedModel: "chosen",
      complete: true,
    }),
  ).toMatchObject({ observedModel: "chosen", modelSelectionReason: null });
});

test("truncated response markers cannot turn a partial match into verified execution", () => {
  expect(
    turnModelEvidence(
      [
        message("chosen"),
        { id: "truncated", at: 2, kind: "other", promptId: "turn", type: "event_truncated", data: {} },
      ],
      { promptId: "turn", requestedModel: "chosen", complete: true },
    ),
  ).toMatchObject({ modelSelectionReason: "model_selection_unverified" });
});

// These cases guard against turning unavailable evidence into a positive failure.
test.each([
  { name: "missing legacy request", requestedModel: null, complete: true, events: [message("different")] },
  { name: "incomplete mismatch read", requestedModel: "chosen", complete: false, events: [message("different")] },
  {
    name: "truncated mismatch read",
    requestedModel: "chosen",
    complete: true,
    events: [
      message("different"),
      { id: "gap", at: 2, kind: "other", promptId: "turn", type: "event_truncated", data: {} } as AgentEvent,
    ],
  },
])("$name remains neutral", ({ requestedModel, complete, events }) => {
  const evidence = turnModelEvidence(events, { promptId: "turn", requestedModel, complete });
  expect(evidence.modelSelectionReason).toBe("model_selection_unverified");
  expect(evidence.modelSelectionMessage).not.toContain("Work may already have occurred");
  expect(evidence.modelSelectionMessage).not.toContain("Do not retry automatically");
});

test("a concrete model does not falsely fail an unresolved native alias", () => {
  expect(
    turnModelEvidence([message("claude-sonnet-5")], { promptId: "turn", requestedModel: "sonnet", complete: true }),
  ).toMatchObject({ observedModel: "claude-sonnet-5", modelSelectionReason: "model_selection_unverified" });
});
