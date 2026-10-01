import { describe, expect, test } from "bun:test";
import { buildOverview } from "@armada/core/read";
import { answerJson, answerOverview, jsonTag, timed } from "../lib/live-http.ts";

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

describe("the polled routes' timing", () => {
  test("a 304 stays a 304, with the time on the server in a header and one log line", async () => {
    const lines: string[] = [];
    const clock = [10, 22.25];
    const body = { entries: [] };
    const answer = await timed(
      "/api/fleet/activity",
      async () => answerJson(poll(jsonTag(body)), body),
      () => clock.shift() ?? 0,
      (line) => lines.push(line),
    );
    expect(answer.status).toBe(304);
    expect(answer.headers.get("server-timing")).toBe("app;dur=12.3");
    expect(lines).toEqual(["armada timing /api/fleet/activity 304 12ms"]);
  });
});
