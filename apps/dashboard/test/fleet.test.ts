import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "../src/lib/events.ts";
import {
  boardState,
  expiryView,
  fleetRow,
  onBoard,
  preview,
  repositoryLabel,
  sortBoard,
  summarizeEvents,
  type TurnSummary,
} from "../src/lib/fleet.ts";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const turn = (status: TurnSummary["status"], reason: string | null = null): TurnSummary => ({
  status,
  reason,
  message: null,
});

describe("summarizeEvents", () => {
  test("takes the latest turn's status and reason and the latest agent message", () => {
    const events: ChatEvent[] = [
      { id: "1", at: 1, kind: "prompt", text: "First", status: "finished", promptId: "p1" },
      { id: "2", at: 2, kind: "message", text: "Done with the first.", partial: false, tools: [], promptId: "p1" },
      { id: "3", at: 3, kind: "prompt", text: "Second", status: "running", promptId: "p2" },
      { id: "4", at: 4, kind: "message", text: "", partial: false, tools: [{ id: "t", name: "Bash" }], promptId: "p2" },
      { id: "5", at: 5, kind: "prompt", text: "", status: "failed", reason: "usage_limit", promptId: "p2" },
    ];
    expect(summarizeEvents(events)).toEqual({
      status: "failed",
      reason: "usage_limit",
      message: "Done with the first.",
    });
  });

  test("is running while any turn is in flight, and empty before the first", () => {
    expect(summarizeEvents([]).status).toBeNull();
    const events: ChatEvent[] = [
      { id: "1", at: 1, kind: "prompt", text: "A", status: "queued", promptId: "a", conversationId: "c1" },
      { id: "2", at: 2, kind: "prompt", text: "B", status: "finished", promptId: "b", conversationId: "c2" },
    ];
    expect(summarizeEvents(events).status).toBe("running");
  });

  test("joins streamed deltas into one message", () => {
    const delta = (id: string, text: string): ChatEvent => ({
      id,
      at: 1,
      kind: "message",
      text,
      partial: true,
      tools: [],
      messageId: "m",
      textMode: "delta",
    });
    expect(summarizeEvents([delta("1", "Hel"), delta("2", "lo")]).message).toBe("Hello");
  });
});

describe("boardState", () => {
  test("a failed sandbox or turn is failed, with the known explanation", () => {
    expect(boardState("failed", turn("failed", "usage_limit"))).toMatchObject({
      kind: "failed",
      failure: { title: "Usage limit reached" },
    });
    expect(boardState("running", turn("failed", "something odd"))).toMatchObject({
      kind: "failed",
      failure: { title: "something odd", hint: null },
    });
    expect(
      boardState("failed", null, { statusReason: null, lifecycleError: "The provider lost the machine." }).failure
        ?.title,
    ).toBe("The provider lost the machine.");
    // The reason the server recorded on the sandbox explains a launch failure, with its fix.
    expect(boardState("failed", null, { statusReason: "auth_expiry", lifecycleError: "later" }).failure).toEqual({
      title: "Credential expired",
      hint: expect.any(String),
      fix: { href: "/credentials", label: "Replace the credential" },
    });
    expect(boardState("failed", null).failure?.title).toBe("Sandbox failed");
  });

  test("a live machine reads its latest turn", () => {
    expect(boardState("running", turn("running")).kind).toBe("working");
    expect(boardState("ready", turn("finished")).kind).toBe("finished");
    expect(boardState("ready", turn("interrupted")).kind).toBe("interrupted");
    expect(boardState("ready", turn(null))).toMatchObject({ kind: "idle", label: "Waiting for a prompt" });
    expect(boardState("starting", turn("finished"))).toMatchObject({ kind: "working", label: "Starting" });
  });

  test("without events a live machine is shown from its status, and a stopped one is stopped", () => {
    expect(boardState("running", null).kind).toBe("working");
    expect(boardState("ready", null)).toMatchObject({ kind: "idle", label: "Ready" });
    expect(boardState("stopped", turn("finished")).kind).toBe("stopped");
    expect(boardState("stopping", null)).toMatchObject({ kind: "stopped", label: "Stopping" });
  });
});

describe("expiryView", () => {
  test("formats the time left and highlights the last half hour", () => {
    expect(expiryView("running", "2026-11-10T14:05:00.000Z", NOW)).toEqual({
      text: "2 h 5 min left",
      urgent: false,
      seconds: 7500,
    });
    expect(expiryView("ready", "2026-11-10T12:29:59.000Z", NOW)).toMatchObject({ text: "29 min left", urgent: true });
    expect(expiryView("ready", "2026-11-10T12:30:00.000Z", NOW)?.urgent).toBe(false);
    expect(expiryView("running", "2026-11-10T11:00:00.000Z", NOW)).toMatchObject({
      text: "Past deadline",
      urgent: true,
    });
  });

  test("says nothing for a stopped machine or a missing deadline", () => {
    expect(expiryView("stopped", "2026-11-10T12:10:00.000Z", NOW)).toBeNull();
    expect(expiryView("running", null, NOW)).toBeNull();
    expect(expiryView("running", "not a date", NOW)).toBeNull();
  });
});

describe("sortBoard", () => {
  test("puts failures, then finished, then expiring, then working, then stopped", () => {
    const row = (id: string, status: Parameters<typeof boardState>[0], t: TurnSummary | null, expires?: string) => ({
      id,
      createdAt: `2026-11-10T0${id.length}:00:00.000Z`,
      state: boardState(status, t),
      expiry: expiryView(status, expires ?? null, NOW),
    });
    const rows = [
      row("stopped", "stopped", null),
      row("working", "running", turn("running"), "2026-11-10T16:00:00.000Z"),
      row("expiring", "running", turn("running"), "2026-11-10T12:10:00.000Z"),
      row("finished-late", "ready", turn("finished"), "2026-11-10T18:00:00.000Z"),
      row("finished-soon", "ready", turn("finished"), "2026-11-10T13:00:00.000Z"),
      row("failed", "failed", null),
    ];
    expect(sortBoard(rows).map((item) => item.id)).toEqual([
      "failed",
      "finished-soon",
      "finished-late",
      "expiring",
      "working",
      "stopped",
    ]);
  });
});

describe("onBoard", () => {
  test("keeps live sandboxes, and stopped or failed ones for a day after they ended", () => {
    const old = "2026-11-01T00:00:00.000Z";
    expect(onBoard({ status: "running", stoppedAt: null, createdAt: old }, NOW)).toBe(true);
    expect(onBoard({ status: "stopped", stoppedAt: "2026-11-10T01:00:00.000Z", createdAt: old }, NOW)).toBe(true);
    expect(onBoard({ status: "stopped", stoppedAt: "2026-11-09T11:00:00.000Z", createdAt: old }, NOW)).toBe(false);
    expect(onBoard({ status: "stopped", stoppedAt: null, createdAt: NOW.toISOString() }, NOW)).toBe(false);
    expect(onBoard({ status: "deleted", stoppedAt: null, createdAt: NOW.toISOString() }, NOW)).toBe(false);
    // A failed sandbox ages out a day after Armada last saw it, else after its launch.
    expect(
      onBoard({ status: "failed", stoppedAt: null, lastObservedAt: "2026-11-10T02:00:00.000Z", createdAt: old }, NOW),
    ).toBe(true);
    expect(onBoard({ status: "failed", stoppedAt: null, lastObservedAt: null, createdAt: old }, NOW)).toBe(false);
  });
});

describe("preview", () => {
  test("keeps a short message whole and cuts a long one at a word", () => {
    expect(preview("  Short\n message ")).toEqual({ text: "Short message", truncated: false });
    const cut = preview("word ".repeat(100), 22);
    expect(cut).toEqual({ text: "word word word word…", truncated: true });
  });
});

describe("repositoryLabel", () => {
  const config = {
    repos: [
      { url: "https://github.com/acme/web.git", branch: "main", dir: "web" },
      { url: "https://github.com/acme/api.git", branch: "develop", dir: "api" },
    ],
    init: [],
  };
  test("names the repository context, the only repository, or how many there are", () => {
    expect(repositoryLabel(config, "api")).toBe("acme/api @ develop");
    expect(repositoryLabel(config, null)).toBe("2 repositories");
    expect(repositoryLabel({ repos: [config.repos[0]], init: [] }, null)).toBe("acme/web @ main");
    expect(repositoryLabel({ nope: true }, null)).toBeNull();
  });
});

describe("fleetRow", () => {
  test("joins the sandbox, its golden and its events", () => {
    const row = fleetRow(
      {
        id: "s1",
        status: "ready",
        harness: "claude",
        model: "claude-opus",
        created_at: "2026-11-10T10:00:00.000Z",
        owner_id: "u1",
        provider_sandbox_id: "bx_one",
        expires_at: "2026-11-10T12:20:00.000Z",
        repository_dir: "web",
      } as Parameters<typeof fleetRow>[0],
      {
        name: "acme",
        config: { repos: [{ url: "git@github.com:acme/web.git", branch: "main", dir: "web" }], init: [] },
      },
      { status: "finished", reason: null, message: "All green." },
      "u2",
      NOW,
    );
    expect(row).toMatchObject({
      name: "bx_one",
      golden: "acme",
      repository: "acme/web @ main",
      mine: false,
      state: { kind: "finished" },
      expiry: { text: "20 min left", urgent: true },
      message: "All green.",
      eventsRead: true,
    });
  });
});
