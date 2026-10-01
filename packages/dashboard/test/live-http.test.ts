import { describe, expect, test } from "bun:test";
import { buildOverview } from "@armada/core/read";
import { answerOverview } from "../lib/live-http.ts";

const overview = (at: string, error: string | null = null) =>
  buildOverview({ projects: [], live: { state: error ? "unreachable" : "ok", error }, now: new Date(at) });
const poll = (tag?: string) =>
  new Request("https://armada.example.test/api/fleet", tag ? { headers: { "if-none-match": tag } } : {});

describe("the live route", () => {
  test("answers 304 while nothing but the clock changed, and the overview again once something did", async () => {
    const first = answerOverview(poll(), overview("2026-03-04T10:00:00Z"));
    expect(first.status).toBe(200);
    const tag = first.headers.get("etag") ?? "";
    expect(first.headers.get("cache-control")).toBe("no-store");

    const same = answerOverview(poll(tag), overview("2026-03-04T10:00:05Z"));
    expect(same.status).toBe(304);
    expect(await same.text()).toBe("");

    const changed = answerOverview(poll(tag), overview("2026-03-04T10:00:10Z", "see the server log"));
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(tag);
    expect(((await changed.json()) as { live: { state: string } }).live.state).toBe("unreachable");
  });
});
