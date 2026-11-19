import { expect, test } from "bun:test";
import { findLastGreen, stagingFailureBody } from "./staging-status.ts";

test("finds the nearest main commit with a current green staging status", async () => {
  const statuses = {
    newer: [{ context: "other", state: "success" }],
    rerun: [
      { context: "staging/smoke", state: "failure" },
      { context: "staging/smoke", state: "success" },
    ],
    green: [{ context: "staging/smoke", state: "success" }],
    older: [{ context: "staging/smoke", state: "success" }],
  };
  const commits = ["newer", "rerun", "green", "older"] as const;
  expect(
    await findLastGreen(commits, async function* (sha) {
      yield* statuses[sha as (typeof commits)[number]];
    }),
  ).toBe("green");
});

test("stops the last-green walk after 50 commits", async () => {
  const commits = Array.from({ length: 51 }, (_, index) => String(index));
  const checked: string[] = [];
  const result = await findLastGreen(commits, async function* (sha) {
    checked.push(sha);
    if (sha === "50") yield { context: "staging/smoke", state: "success" };
  });
  expect(result).toBeUndefined();
  expect(checked).toEqual(commits.slice(0, 50));
});

test("reports the failed step codes with the SHA range and run link", () => {
  const body = stagingFailureBody(
    "failed-sha",
    "green-sha",
    "https://example.com/runs/1",
    [
      "runner output",
      '{"pass":true,"step":"launch"}',
      '{"pass":false,"step":"dashboard_sandboxes","code":"read_timeout","details":"omit me"}',
      '{"pass":false,"step":"smoke_cleanup_journal"}',
    ].join("\n"),
  );
  expect(body).toContain("`green-sha..failed-sha`");
  expect(body).toContain("https://example.com/runs/1");
  expect(body).toContain("`dashboard_sandboxes` — `read_timeout`");
  expect(body).toContain("`smoke_cleanup_journal` — `code unavailable`");
  expect(body).not.toContain("omit me");
  expect(body).not.toContain("launch");
});
