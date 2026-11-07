import { expect, test } from "bun:test";
import { type Credentials, type MergeOutcome, parseConfig } from "@armada/core";
import { DEMO_TOML } from "../../core/test/support.ts";
import { afterMerge } from "../src/after-merge.ts";
import type { Io } from "../src/io.ts";

test("a sibling suppresses archive and deferred launches even without a keepOpen flag", async () => {
  const calls: string[] = [];
  const io = new Proxy(
    {},
    {
      get(_target, key) {
        calls.push(String(key));
        throw new Error("no runtime/API operation expected");
      },
    },
  ) as Io;
  const outcome = {
    merged: true,
    keepOpen: false,
    pr: {
      number: 9,
      title: "synthetic",
      url: "https://github.com/acme/widgets/pull/9",
      base: "main",
      headSha: "a".repeat(40),
      mergeCommit: "b".repeat(40),
    },
    ticket: { id: "DEMO-7", url: "https://linear.app/acme/issue/DEMO-7" },
    remainingHandBacks: [
      {
        schema: "hand-back/v2",
        id: 2,
        project: "widgets",
        repository: "acme/widgets",
        ticket: "DEMO-7",
        pr: 10,
        headSha: "c".repeat(40),
        claimGeneration: "d".repeat(64),
      },
    ],
    archive: { runtime: "conductor", handle: "synthetic", guide: null, source: "armada", claim: null, open: [] },
    lines: [],
    hints: [],
    warnings: [],
    workers: [],
    workersListed: true,
    unblocked: null,
  } as MergeOutcome;
  let deferred: unknown;
  const result = await afterMerge(io, parseConfig(DEMO_TOML), {} as Credentials, outcome, {
    noNotify: true,
    onDeferredLaunch: async (x) => {
      deferred = x;
    },
  });
  expect(result.archive).toMatchObject({ archived: false, detail: "ticket kept open" });
  expect(deferred).toEqual([]);
  expect(calls).toEqual([]);
});
