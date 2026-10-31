import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { nativeTools, openCoordinatorStorage, SYSTEM_PROMPT, TOOL_NAMES } from "../coordinator/index.ts";
import { EventStore } from "../src/store.ts";

// The prompt is model input: its ordering, vocabulary and capability claims are a public contract.
test("the coordinator reads, resolves, launches, merges and reports before the tool rulebook", () => {
  const [loop = "", ...rest] = SYSTEM_PROMPT.split("## Tool rules");
  assert.ok(loop.startsWith("## Turn loop\n"), "the ordered loop comes first");
  assert.ok(rest.length, "tool rules follow the loop");
  const steps = [...loop.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1] ?? "");
  assert.equal(steps.length, 5);
  assert.match(steps[0] ?? "", /`fleet.status`.*`inbox.list`/);
  assert.match(steps[1] ?? "", /oldest first/);
  assert.match(steps[2] ?? "", /launch.*cap/i);
  assert.match(steps[3] ?? "", /merge/i);
  assert.match(steps[4] ?? "", /at most five lines.*owner's language/);
  assert.match(steps[4] ?? "", /one.*line.*never nothing/);
  assert.match(steps[4] ?? "", /tickets/);
});

test("every tool mentioned by the prompt exists and every offered tool has a rule", () => {
  const mentioned = [...SYSTEM_PROMPT.matchAll(/`([a-z]+\.[a-z]+)`/g)].map((m) => m[1] ?? "");
  for (const name of mentioned) assert.ok(TOOL_NAMES.includes(name as (typeof TOOL_NAMES)[number]), name);
  const rules = [...SYSTEM_PROMPT.matchAll(/^- `([a-z]+\.[a-z]+)`:/gm)].map((m) => m[1] ?? "");
  assert.deepEqual(rules.sort(), [...TOOL_NAMES].sort());
});

test("status promises exclude evidence the actual tool marks unavailable", async (t) => {
  const at = "2030-01-01T00:00:00.000Z";
  const store = new EventStore(":memory:");
  store.append({
    project: "orchard",
    at,
    actor: "tracker",
    kind: "ticket.seen",
    payload: { id: "ORC-1", title: "Plant seeds", status: "unstarted", labels: ["ready-for-agent"] },
  });
  const scope = openCoordinatorStorage({ store, project: "orchard", now: () => at });
  t.after(async () => {
    await scope.close(context);
    store.close();
  });
  const result = await nativeTools(scope, { now: () => at })["fleet.status"].execute(
    {},
    {} as ToolExecutionApi,
    context,
  );
  const facts = result.details as { ok: boolean; unavailable: string[] };
  assert.equal(facts.ok, true);
  assert.ok(facts.unavailable.length);
  const unavailable = SYSTEM_PROMPT.split("## Unavailable evidence")[1]?.split("##")[0] ?? "";
  const statusRule = SYSTEM_PROMPT.match(/^- `fleet.status`: (.+)$/m)?.[1] ?? "";
  assert.ok(statusRule);
  const concepts: Record<string, RegExp> = {
    "frontier-blockers": /ready frontier|frontier with blockers/,
    "runtime-observations": /runtime observations/,
    jobs: /jobs/,
    "default-branch-health": /default.branch health|main health/,
    "launch-capacity": /launch capacity/,
  };
  for (const field of facts.unavailable) {
    assert.ok(unavailable.includes(`\`${field}\``), `explain missing ${field}`);
    assert.ok(concepts[field], `classify new unavailable evidence ${field}`);
    assert.doesNotMatch(statusRule, concepts[field], `do not promise ${field}`);
  }
});
