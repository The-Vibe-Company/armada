import { expect, test } from "bun:test";
import { checkedHandBackState, HAND_BACK_SCHEMA, type HandBackState, parseHandBackRef } from "../src/hand-backs.ts";

const ref = {
  schema: HAND_BACK_SCHEMA,
  id: 1,
  project: "demo",
  repository: "example/widgets",
  ticket: "THE-1",
  pr: 2,
  headSha: "a".repeat(40),
  claimGeneration: "b".repeat(64),
};
const state: HandBackState = {
  schema: HAND_BACK_SCHEMA,
  serverRevision: "c".repeat(40),
  project: "demo",
  repository: "example/widgets",
  ticket: "THE-1",
  claimGeneration: ref.claimGeneration,
  complete: true,
  items: [],
  merges: [],
};
test("capability requires current schema, build revision, completeness and own tuple", () => {
  expect(checkedHandBackState(state, "demo", "THE-1")).toEqual(state);
  for (const patch of [
    { schema: "hand-back/v1" },
    { serverRevision: null },
    { complete: false },
    { project: "foreign" },
    { ticket: "THE-2" },
    { merges: null },
  ])
    expect(() => checkedHandBackState({ ...state, ...patch }, "demo", "THE-1")).toThrow();
  for (const patch of [
    { id: 0 },
    { pr: 0 },
    { headSha: "short" },
    { claimGeneration: "caller" },
    { repository: "../foreign" },
  ])
    expect(() => parseHandBackRef({ ...ref, ...patch })).toThrow();
});
test("cleanup projection must carry an explicit server-derived supersession decision", () => {
  const receipt = { handBack: ref, mergedHeadSha: ref.headSha, mergeCommit: "d".repeat(40), verifiedMainLineage: null };
  expect(() => checkedHandBackState({ ...state, merges: [{ receipt, keepOpen: false }] }, "demo", "THE-1")).toThrow();
  expect(
    checkedHandBackState({ ...state, merges: [{ receipt, keepOpen: false, superseded: false }] }, "demo", "THE-1")
      .merges,
  ).toHaveLength(1);
});
