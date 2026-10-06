import { expect, test } from "bun:test";
import type { ShownQueueEntry } from "@armada/core/read";
import { mergeAsked, queueRows } from "../lib/queue-view.ts";

const NOW = Date.parse("2026-03-04T10:00:00Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const entry = (id: number, pr: number, over: Partial<ShownQueueEntry> = {}): ShownQueueEntry => ({
  id,
  pr,
  ticket: `WID-${pr}`,
  state: "queued",
  detail: null,
  queuedBy: "Ada",
  queuedAt: at(-10),
  updatedAt: at(-10),
  notBefore: null,
  ...over,
});

test("the queue reads in drain order with what each entry waits on, then what was refused", () => {
  const queue = [
    entry(1, 12, { state: "merging", detail: "Waiting: the checks on the updated head of #12…" }),
    entry(2, 15, { notBefore: at(5), detail: "GitHub answered HTTP 502" }),
    entry(3, 18, { queuedBy: "coordinator" }),
    entry(4, 9, { state: "refused", detail: "CI failed on test" }),
  ];
  const pullRequests = [{ number: 12, title: "Show the queue", url: "https://github.com/acme/widgets/pull/12" }];
  const rows = queueRows({ queue, pullRequests } as never, NOW);
  expect(rows.map((r) => [r.position, r.pr, r.state])).toEqual([
    [1, 12, "merging"],
    [2, 15, "retry"],
    [3, 18, "queued"],
    [null, 9, "refused"],
  ]);
  expect(rows[0]).toMatchObject({
    title: "Show the queue",
    url: "https://github.com/acme/widgets/pull/12",
    waiting: "the checks on the updated head of #12",
  });
  expect(rows[1]).toMatchObject({ title: null, waiting: null, notBefore: at(5), detail: "GitHub answered HTTP 502" });
  // A retry whose time has come is simply queued again.
  expect(queueRows({ queue: [entry(2, 15, { notBefore: at(-1) })], pullRequests: null } as never, NOW)[0]?.state).toBe(
    "queued",
  );
  expect(queueRows({ pullRequests: null } as never, NOW)).toEqual([]);
});

test("a Merge press shows as queued while its entry is open, else as asked of the coordinator", () => {
  const request = { kind: "merge-request", author: "Bea", createdAt: at(-2), request: { pr: 15 } };
  const project = {
    queue: [entry(1, 12), entry(2, 9, { state: "refused" })],
    requests: [request],
  } as never;
  expect(mergeAsked(project, 12)).toEqual({ queued: true, author: "Ada", at: at(-10) });
  expect(mergeAsked(project, 15)).toEqual({ queued: false, author: "Bea", at: at(-2) });
  expect(mergeAsked(project, 9)).toBeNull();
  expect(mergeAsked(undefined, 12)).toBeNull();
});
