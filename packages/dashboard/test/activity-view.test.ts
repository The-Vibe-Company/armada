import { describe, expect, test } from "bun:test";
import type { FeedEntry } from "@armada/core/read";
import {
  activityHref,
  activityQuery,
  entryHref,
  entryWhat,
  entryWho,
  feedDays,
  zoneOf,
} from "../lib/activity-view.ts";
import { STRINGS } from "../lib/i18n.ts";

// Synthetic entries, for these tests only.
const en = STRINGS.en;
const entry = (key: string, at: string, over: Partial<FeedEntry> = {}): FeedEntry => ({
  key,
  project: "widgets",
  ticket: "WID-1",
  kind: "report",
  at,
  actor: { kind: "agent", name: null },
  text: null,
  phase: "implementing",
  detail: null,
  ref: null,
  ...over,
});

describe("the Activity page's address", () => {
  test("reads its filters and drops what it cannot use", () => {
    expect(
      activityQuery({ project: "widgets", ticket: " wid-12 ", kind: "merge", who: "Ada Lovelace", before: "x" }),
    ).toEqual({
      project: "widgets",
      ticket: "WID-12",
      kind: "merge",
      who: { kind: "person", name: "Ada Lovelace" },
      before: null,
    });
    expect(activityQuery({ project: "Not A Slug", ticket: "drop table", kind: "everything", who: "" })).toEqual({
      project: null,
      ticket: null,
      kind: null,
      who: null,
      before: null,
    });
  });

  test("writes only what is set, in one order, and reads back the same", () => {
    expect(activityHref({})).toBe("/activity");
    const q = activityQuery({ who: "coordinator", kind: "claim", project: "widgets" });
    const href = activityHref(q);
    expect(href).toBe("/activity?project=widgets&kind=claim&who=coordinator");
    const before = { at: "2026-03-04T10:00:00.000Z", key: "e:7" };
    const paged = activityHref({ ...q, before });
    expect(activityQuery(Object.fromEntries(new URL(paged, "http://x").searchParams))).toEqual({ ...q, before });
  });

  test("keeps a time zone the server knows", () => {
    expect(zoneOf("Europe/Paris")).toBe("Europe/Paris");
    expect(zoneOf("Mars/Olympus")).toBe("UTC");
    expect(zoneOf(undefined)).toBe("UTC");
  });
});

describe("an entry", () => {
  test("says what happened, who did it and where it opens", () => {
    expect(entryWhat(en, entry("e:1", "2026-03-04T10:00:00Z"))).toBe("Reported · Implementing");
    const decision = entry("d:3", "2026-03-04T10:00:00Z", {
      kind: "decision",
      detail: "changes",
      ref: 3,
      actor: { kind: "person", name: "Ada" },
    });
    expect([entryWhat(en, decision), entryWho(en, decision), entryHref(decision)]).toEqual([
      "Asked for changes",
      "Ada",
      "/approve/3",
    ]);
    const stop = entry("c:9:stop", "2026-03-04T10:00:00Z", {
      kind: "coordinator",
      ticket: null,
      detail: "stop",
      actor: { kind: "coordinator", name: null },
    });
    expect([entryWhat(en, stop), entryWho(en, stop), entryHref(stop)]).toEqual([
      "Coordinator stopped",
      "coordinator",
      "/projects/widgets",
    ]);
    expect(entryHref(entry("e:2", "2026-03-04T10:00:00Z"))).toBe("/agents/WID-1");
  });
});

describe("the days", () => {
  const list = [
    entry("e:5", "2026-03-05T09:00:00Z"),
    entry("e:4", "2026-03-04T23:30:00Z"),
    entry("e:3", "2026-03-04T22:00:00Z"),
    entry("e:2", "2026-03-04T08:00:00Z"),
  ];
  const now = new Date("2026-03-05T12:00:00Z");

  test("group the entries in the viewer's time zone", () => {
    expect(feedDays(en, list, { zone: "UTC", now, since: null }).days.map((d) => [d.label, d.seen.length])).toEqual([
      ["Today", 1],
      ["Yesterday", 3],
    ]);
    // 23:30 UTC is already the 5th in Paris.
    expect(
      feedDays(en, list, { zone: "Europe/Paris", now, since: null }).days.map((d) => [d.label, d.seen.length]),
    ).toEqual([
      ["Today", 2],
      ["Yesterday", 2],
    ]);
  });

  test("split at the last visit, only when the page holds both sides", () => {
    const split = feedDays(en, list, { zone: "UTC", now, since: "2026-03-04T23:00:00Z" });
    expect(split.divider).toBe("2026-03-04T23:00:00Z");
    expect(split.days.map((d) => [d.fresh.map((e) => e.key), d.seen.map((e) => e.key)])).toEqual([
      [["e:5"], []],
      [["e:4"], ["e:3", "e:2"]],
    ]);
    expect(feedDays(en, list, { zone: "UTC", now, since: "2026-03-01T00:00:00Z" }).divider).toBeNull();
    expect(feedDays(en, list, { zone: "UTC", now, since: "2026-03-06T00:00:00Z" }).divider).toBeNull();
  });
});
