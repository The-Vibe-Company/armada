import { expect, test } from "bun:test";
import type { AgentEvent } from "../src/provider.ts";
import { turnModelEvidence } from "../src/turn-model.ts";

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

// Coordinator's redacted 2026-11-10 12:35Z recording, not an invented native SDK stream:
// accepted request claude-fable-5-2; one main response model/text claude-sonnet-5;
// native api-request already selected sonnet, no refusal-fallback notice.
test("production recording fails the requested-model contract while retaining observed model", () => {
  const evidence = turnModelEvidence([message("claude-sonnet-5", { text: "claude-sonnet-5" })], {
    promptId: "turn",
    requestedModel: "claude-fable-5-2",
    complete: true,
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
    reason: "model_selection_mismatch",
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
