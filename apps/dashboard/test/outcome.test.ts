import { describe, expect, test } from "bun:test";
import type { SandboxPullRequest } from "@armada/core";
import {
  outcomeView,
  parseTaskOutcome,
  preservationView,
  reportedPullRequest,
  safeHref,
  settledOutcome,
} from "../src/lib/outcome.ts";

const SHA = "0123456789abcdef0123456789ABCDEF01234567";
const ID = "00000000-0000-4000-8000-000000000032";

describe("parseTaskOutcome", () => {
  test("keeps an outcome the database allows", () => {
    const ready = { state: "ready", prNumber: 768, prUrl: "https://github.com/acme/web/pull/768", headSha: SHA };
    expect(parseTaskOutcome(ready)).toEqual(ready);
    expect(parseTaskOutcome({ state: "ready" })).toEqual({ state: "ready" });
    // Characters, not UTF-16 units: 600 emoji are within the 1000 the database allows.
    expect(parseTaskOutcome({ state: "blocked", reason: "🚧".repeat(600) })).not.toBeNull();
    expect(parseTaskOutcome({ state: "blocked", reason: "  Needs a key  " })).toEqual({
      state: "blocked",
      reason: "Needs a key",
    });
  });

  test("refuses anything else rather than guess", () => {
    for (const value of [
      null,
      "ready",
      [],
      { state: "done" },
      { state: "blocked" },
      { state: "blocked", reason: "   " },
      { state: "ready", prNumber: 0 },
      { state: "ready", prNumber: "12" },
      { state: "ready", prUrl: "" },
      { state: "ready", headSha: "abc123" },
      { state: "ready", extra: true },
      { state: "ready", prUrl: `https://github.com/${"x".repeat(2048)}` },
      { state: "blocked", reason: "x".repeat(1001) },
      { state: "blocked", reason: "why", prNumber: 1 },
    ])
      expect(parseTaskOutcome(value)).toBeNull();
  });
});

describe("outcomeView", () => {
  test("reads ready to merge with its pull request and short commit", () => {
    expect(
      outcomeView({ state: "ready", prNumber: 768, prUrl: "https://github.com/acme/web/pull/768", headSha: SHA }),
    ).toEqual({
      kind: "ready",
      label: "Ready to merge",
      pr: { label: "PR #768", href: "https://github.com/acme/web/pull/768" },
      sha: "0123456",
      merged: false,
    });
    expect(outcomeView({ state: "ready", prUrl: "https://github.com/acme/web/pull/9" })).toMatchObject({
      pr: { label: "Pull request", href: "https://github.com/acme/web/pull/9" },
    });
    expect(outcomeView({ state: "ready" })).toMatchObject({ pr: null, sha: null });
  });

  test("never links an unsafe address", () => {
    expect(outcomeView({ state: "ready", prNumber: 3, prUrl: "javascript:alert(1)" })).toMatchObject({
      pr: { label: "PR #3", href: null },
    });
    expect(outcomeView({ state: "ready", prUrl: "http://github.com/x" })).toMatchObject({ pr: null });
    // The agent writes the address: another site is never labelled as its pull request.
    expect(outcomeView({ state: "ready", prNumber: 4, prUrl: "https://evil.example/pull/4" })).toMatchObject({
      pr: { label: "PR #4", href: null },
    });
    expect(safeHref("https://user:pw@github.com/a/b/pull/1")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
  });

  test("reads blocked with its reason, and nothing as nothing", () => {
    expect(outcomeView({ state: "blocked", reason: "Needs review" })).toEqual({
      kind: "blocked",
      label: "Blocked",
      reason: "Needs review",
    });
    expect(outcomeView(null)).toBeNull();
  });
});

describe("reported pull request confirmed by GitHub", () => {
  const confirmed = (state: SandboxPullRequest["state"], repository = "acme/web", number = 42): SandboxPullRequest => ({
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    headBranch: "topic",
    state,
    checkedAt: "2026-11-18T08:00:00.000Z",
  });
  const ready = { state: "ready", prNumber: 42, prUrl: "https://github.com/acme/web/pull/42" } as const;

  test("a reported ready pull request reads Merged once GitHub confirms that same pull request merged", () => {
    expect(outcomeView(ready, [confirmed("open")])).toMatchObject({ label: "Ready to merge", merged: false });
    expect(outcomeView(ready, [confirmed("merged")])).toMatchObject({ kind: "ready", label: "Merged", merged: true });
    expect(settledOutcome("stopped", ready, [confirmed("merged")])).toMatchObject({ label: "Merged", merged: true });
    expect(outcomeView(ready, [confirmed("closed")])).toMatchObject({ label: "Ready to merge", merged: false });
  });

  test("matches on repository and number, never on a different or ambiguous pull request", () => {
    expect(outcomeView(ready, [confirmed("merged", "acme/other")])).toMatchObject({ merged: false });
    expect(outcomeView(ready, [confirmed("merged", "acme/web", 43)])).toMatchObject({ merged: false });
    expect(reportedPullRequest(ready, [confirmed("merged", "ACME/Web")])?.state).toBe("merged");
    // The link and the number disagree: the outcome names no single pull request.
    expect(reportedPullRequest({ ...ready, prNumber: 43 }, [confirmed("merged")])).toBeNull();
    // A number without a link matches only when one confirmed pull request has it.
    expect(outcomeView({ state: "ready", prNumber: 42 }, [confirmed("merged")])).toMatchObject({ merged: true });
    expect(
      outcomeView({ state: "ready", prNumber: 42 }, [confirmed("merged"), confirmed("open", "acme/other")]),
    ).toMatchObject({ merged: false });
    expect(outcomeView({ state: "ready" }, [confirmed("merged")])).toMatchObject({ merged: false });
  });
});

describe("settledOutcome", () => {
  test("deleted, starting or stopping sandboxes hide earlier outcomes; failures retain completed work", () => {
    const ready = { state: "ready", prNumber: 123, prUrl: "https://github.com/acme/web/pull/123" } as const;
    expect(settledOutcome("failed", ready)).toMatchObject({
      kind: "ready",
      pr: { label: "PR #123", href: ready.prUrl },
    });
    expect(settledOutcome("failed", { state: "blocked", reason: "Needs review" })).toEqual({
      kind: "blocked",
      label: "Blocked",
      reason: "Needs review",
    });
    for (const status of ["ready", "running", "stopped", "failed"] as const)
      expect(settledOutcome(status, ready)?.kind).toBe("ready");
    for (const status of ["deleted", "starting", "stopping"] as const) expect(settledOutcome(status, ready)).toBeNull();
  });
});

describe("preservationView", () => {
  const preserved = `unpushed work preserved at work_recovery:${ID}/00000000-0000-4000-8000-000000000099`;

  test("a preserved archive gives its owner or an admin the recovery command", () => {
    expect(preservationView(preserved, "stopped", ID, true)).toEqual({
      kind: "preserved",
      text: "Unpushed work preserved",
      command: `armada recovery ${ID} > armada-recovery.json`,
    });
    expect(preservationView(preserved, "stopped", ID, false)).toMatchObject({ kind: "preserved", command: null });
  });

  test("a failed attempt says why, and any other note is shown as written", () => {
    expect(preservationView("unpushed work could not be preserved (size_limit)", "stopped", ID, true)).toEqual({
      kind: "failed",
      text: "Unpushed work could not be preserved (size_limit)",
      reason: "size_limit",
    });
    const actionable =
      "unpushed work could not be preserved (exec_failed). Resume the sandbox and push or copy any local work before stopping again.";
    expect(preservationView(actionable, "stopped", ID, true)).toEqual({
      kind: "failed",
      reason: "exec_failed",
      text: actionable.replace(/^unpushed/, "Unpushed"),
    });
    expect(preservationView("something else", "stopped", ID, true)).toEqual({ kind: "other", text: "something else" });
  });

  test("unknown work is informational, not a confirmed preservation failure", () => {
    const note =
      "could not check for unpushed work (collect_exec_not_ready). If this sandbox had local work, resume it and push or copy it before stopping again.";
    expect(preservationView(note, "stopped", ID, true)).toEqual({
      kind: "unknown",
      reason: "collect_exec_not_ready",
      text: note.replace(/^could/, "Could"),
    });
  });

  test("only an ended sandbox with a note shows one; stopping a failed sandbox keeps it failed", () => {
    expect(preservationView(preserved, "failed", ID, true)).toMatchObject({ kind: "preserved" });
    expect(preservationView(preserved, "running", ID, true)).toBeNull();
    expect(preservationView(null, "stopped", ID, true)).toBeNull();
    expect(preservationView("  ", "stopped", ID, true)).toBeNull();
  });
});
