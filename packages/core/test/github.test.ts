import { describe, expect, test } from "bun:test";
import { fetchForge, ticketIdFromBranch } from "../src/github.ts";
import { NOW, recordedFetch } from "./support.ts";

describe("ticketIdFromBranch", () => {
  const known = new Set(["ABC-12", "XY2-7"]);

  test("finds a known ticket id with any team key, in any case and position", () => {
    expect(ticketIdFromBranch("feature/abc-12-add-login", known)).toBe("ABC-12");
    expect(ticketIdFromBranch("XY2-7", known)).toBe("XY2-7");
    expect(ticketIdFromBranch("fix/utf-8-then-abc-12", known)).toBe("ABC-12");
  });

  test("ignores ids that are not in the program or glued to other words", () => {
    expect(ticketIdFromBranch("feature/abc-13-other", known)).toBeNull();
    expect(ticketIdFromBranch("feature/xabc-12", known)).toBeNull();
  });
});

describe("fetchForge", () => {
  test("a timed-out GitHub query retries once with the same request", async () => {
    const recorded = recordedFetch();
    let calls = 0;
    const forge = await fetchForge({
      token: "synthetic-token",
      repository: "acme/widgets",
      fetch: async (url, init) => {
        if (++calls === 1) throw new DOMException("timed out", "TimeoutError");
        return recorded.fetch(url, init);
      },
    });
    expect(calls).toBe(2);
    expect(forge.prs.length).toBeGreaterThan(0);
  });

  test("reads open and recent pull requests with their CI rollup and mergeability", async () => {
    const { fetch, calls } = recordedFetch();
    const forge = await fetchForge({ token: "gh_test", repository: "acme/widgets", fetch, now: () => NOW });
    expect(calls[0]).toMatchObject({ authorization: "Bearer gh_test", variables: { owner: "acme", name: "widgets" } });
    expect(forge.prs.map((p) => [p.number, p.state, p.draft, p.ci, p.mergeable])).toEqual([
      [10, "open", true, "none", "MERGEABLE"],
      [9, "open", false, "success", "MERGEABLE"],
      [8, "open", false, "failure", "MERGEABLE"],
      [7, "open", false, "pending", "UNKNOWN"],
      [6, "merged", false, "success", "MERGEABLE"],
    ]);
  });

  test("an unknown repository is an error, not an empty list", async () => {
    const { fetch } = recordedFetch({ github: { data: { repository: null } } });
    await expect(fetchForge({ token: "t", repository: "acme/nope", fetch })).rejects.toThrow(
      "repository acme/nope not found",
    );
  });
});

test("GitHub reads recover from a temporary HTTP status", async () => {
  let calls = 0;
  const waits: number[] = [];
  const recorded = recordedFetch();
  const forge = await fetchForge({
    token: "synthetic-token",
    repository: "acme/widgets",
    random: () => 0.5,
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetch: async (url, init) => (++calls === 1 ? new Response("busy", { status: 502 }) : recorded.fetch(url, init)),
  });
  expect(forge.prs.length).toBeGreaterThan(0);
  expect(calls).toBe(2);
  expect(waits).toEqual([1000]);
});
