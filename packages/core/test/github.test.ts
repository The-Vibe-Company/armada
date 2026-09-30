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
