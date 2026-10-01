import { describe, expect, test } from "bun:test";
import {
  type CatchupRecords,
  cursorOf,
  cursorText,
  feedWhoOf,
  feedWhoText,
  showSummary,
  sinceSummary,
  visitSince,
} from "../src/catchup.ts";

// Synthetic projects and tickets, for these tests only.
const T0 = Date.parse("2026-03-04T10:00:00Z");
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const NOW = new Date(T0 + 120 * 60_000);

const records = (over: Partial<CatchupRecords> = {}): CatchupRecords => ({
  project: "widgets",
  silentAfterMinutes: 15,
  merged: [],
  claimed: [],
  gaps: [],
  blocked: [],
  waiting: [],
  ...over,
});

describe("a visit", () => {
  test("starts a new one after more than 30 minutes away, from when they were last seen", () => {
    const v = { seenAt: iso(60), since: iso(0), dismissedSince: null };
    expect(visitSince(v, new Date(T0 + 89 * 60_000))).toBe(iso(0));
    expect(visitSince(v, new Date(T0 + 91 * 60_000))).toBe(iso(60));
  });

  test("shows its summary until it is dismissed, and again on the next visit", () => {
    const v = { seenAt: iso(100), since: iso(0), dismissedSince: null };
    expect(showSummary(v, NOW)).toBe(true);
    expect(showSummary({ ...v, dismissedSince: iso(0) }, NOW)).toBe(false);
    // Back after an hour away: a new start, not the one dismissed.
    expect(showSummary({ ...v, dismissedSince: iso(0) }, new Date(T0 + 200 * 60_000))).toBe(true);
  });

  test("has no summary on the first visit", () => {
    expect(showSummary({ seenAt: null, since: null, dismissedSince: null }, NOW)).toBe(false);
  });
});

describe("since you were away", () => {
  test("counts each ticket merged or started since then once, newest first, across projects", () => {
    const s = sinceSummary({
      since: iso(30),
      now: NOW,
      records: [
        records({
          merged: [
            { ticket: "W-1", at: iso(40) },
            { ticket: "W-2", at: iso(20) },
            { ticket: "W-3", at: iso(90) },
          ],
          claimed: [
            { ticket: "W-4", at: iso(50) },
            { ticket: "W-4", at: iso(70) },
          ],
        }),
        records({ project: "gadgets", merged: [{ ticket: "G-1", at: iso(60) }] }),
      ],
    });
    expect(s.merged).toEqual([
      { project: "widgets", ticket: "W-3" },
      { project: "gadgets", ticket: "G-1" },
      { project: "widgets", ticket: "W-1" },
    ]);
    expect(s.started).toEqual([{ project: "widgets", ticket: "W-4" }]);
    expect(s.quiet).toBe(false);
  });

  test("names a silence longer than the project's threshold that ended or lasts since then, the longest per ticket", () => {
    const s = sinceSummary({
      since: iso(30),
      now: NOW,
      records: [
        records({
          gaps: [
            // Ended before the visit's start: not news.
            { ticket: "W-1", from: iso(0), to: iso(25) },
            // Crossed the start: its whole length counts.
            { ticket: "W-2", from: iso(10), to: iso(50) },
            { ticket: "W-2", from: iso(60), to: iso(80) },
            // At the threshold: not a silence.
            { ticket: "W-3", from: iso(60), to: iso(75) },
            // Going on now.
            { ticket: "W-4", from: iso(100), to: null },
          ],
        }),
      ],
    });
    expect(s.stuck).toEqual([
      { project: "widgets", ticket: "W-4", reason: "silent", minutes: 20, ongoing: true },
      { project: "widgets", ticket: "W-2", reason: "silent", minutes: 40, ongoing: false },
    ]);
  });

  test("names a ticket that got blocked; a silence going on wins over it", () => {
    const s = sinceSummary({
      since: iso(30),
      now: NOW,
      records: [
        records({
          gaps: [
            { ticket: "W-1", from: iso(40), to: iso(70) },
            { ticket: "W-2", from: iso(40), to: null },
          ],
          blocked: [
            { ticket: "W-1", at: iso(80) },
            { ticket: "W-2", at: iso(35) },
            { ticket: "W-3", at: iso(10) },
          ],
        }),
      ],
    });
    expect(s.stuck).toEqual([
      { project: "widgets", ticket: "W-2", reason: "silent", minutes: 80, ongoing: true },
      { project: "widgets", ticket: "W-1", reason: "blocked", minutes: null, ongoing: false },
    ]);
  });

  test("lists what waits for the owner now, however old", () => {
    const s = sinceSummary({
      since: iso(30),
      now: NOW,
      records: [
        records({
          waiting: [
            { id: 9, ticket: "W-1", kind: "question" },
            { id: 4, ticket: "W-2", kind: "merge" },
          ],
        }),
      ],
    });
    expect(s.waiting.map((w) => w.id)).toEqual([4, 9]);
    expect(s.quiet).toBe(false);
  });

  test("is quiet when nothing happened", () => {
    const s = sinceSummary({ since: iso(30), now: NOW, records: [records()] });
    expect(s).toEqual({ since: iso(30), merged: [], started: [], stuck: [], waiting: [], quiet: true });
  });
});

describe("the feed's address", () => {
  test("pages on a cursor it reads back, and refuses one it did not write", () => {
    const c = { at: iso(5), key: "e:42" };
    expect(cursorOf(cursorText(c))).toEqual(c);
    expect(cursorOf("yesterday~e:42")).toBeNull();
    expect(cursorOf(`${iso(5)}~'; DROP`)).toBeNull();
    expect(cursorOf(null)).toBeNull();
  });

  test("names who: the coordinator, the agents or a person", () => {
    expect(feedWhoOf("coordinator")).toEqual({ kind: "coordinator" });
    expect(feedWhoOf("agents")).toEqual({ kind: "agent" });
    expect(feedWhoOf(" Ada Lovelace ")).toEqual({ kind: "person", name: "Ada Lovelace" });
    expect(feedWhoOf("")).toBeNull();
    for (const w of ["coordinator", "agents", "Ada"]) expect(feedWhoText(feedWhoOf(w) ?? { kind: "agent" })).toBe(w);
  });
});
