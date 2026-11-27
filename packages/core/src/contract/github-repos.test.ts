import { expect, test } from "bun:test";
import { githubReposOperation, githubReposRequest, githubReposResponse } from "./github-repos.ts";

test("github/repos contract validates EMU slugs, filters, and responses", () => {
  expect(githubReposOperation.route).toEqual({ method: "POST", path: "/api/v1/github/repos" });
  expect(githubReposOperation.successHeaders["Cache-Control"].parse("no-store")).toBe("no-store");
  expect(githubReposRequest.parse({ account: "acme_emu", query: "api", limit: 50 }).account).toBe("acme_emu");
  expect(githubReposRequest.safeParse({ account: "../bad" }).success).toBe(false);
  expect(githubReposRequest.safeParse({ extra: true }).success).toBe(false);
  const base = { accountLogin: "acme_emu", accountType: "Organization", repositorySelection: "all" } as const;
  const inst = { id: 101, appId: 4242, appSlug: "armada-tvc", ...base };
  const repo = {
    id: 1,
    owner: "acme_emu",
    name: "api",
    fullName: "acme_emu/api",
    private: true,
    defaultBranch: "main",
    installationId: 101,
    archived: false,
    pushedAt: null,
    ...base,
  };
  const res = githubReposResponse.parse({ installations: [inst], repositories: [repo], truncated: false });
  expect(res.repositories[0]?.fullName).toBe("acme_emu/api");
});
