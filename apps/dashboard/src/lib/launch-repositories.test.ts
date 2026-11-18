import { expect, test } from "bun:test";
import type { LaunchStartTarget } from "./launch-picker";
import {
  launchRepositoryChoices,
  launchRepositoryFolder,
  launchRepositoryInput,
  launchRepositoryStarts,
  launchRepositoryTemplates,
} from "./launch-repositories";

function start(id: string, createdAt: string, url: string, reason?: string): LaunchStartTarget {
  return {
    id,
    createdAt,
    provider: "boat",
    golden: id,
    label: id,
    group: "Boat cloud",
    ...(reason ? { reason } : {}),
    repositories: [{ url, dir: id }],
  };
}

test("counts each ready snapshot once for the same repository identity", () => {
  const first = start("web", "2026-11-01", "https://github.com/Example/Web.git");
  const second = start("older", "2026-10-31", "git@github.com:example/web.git");
  const failed = start("failed", "2026-11-02", "https://github.com/example/web", "Build did not finish");
  expect(
    launchRepositoryChoices([
      { ...first, repositories: [...first.repositories, ...first.repositories] },
      second,
      failed,
    ]),
  ).toEqual([["example/web", 2]]);
});

test("recognizes a typed owner and repository without treating arbitrary URLs as choices", () => {
  expect(launchRepositoryInput(" Example/Web ")).toBe("example/web");
  expect(launchRepositoryInput("https://github.com/example/web")).toBeNull();
  expect(launchRepositoryInput("example")).toBeNull();
});

test("filters starts newest first and prefers a ready match over a newer failure", () => {
  const old = start("old", "2026-11-01", "https://github.com/example/web");
  const failed = start("new", "2026-11-02", "git@github.com:example/web.git", "Build did not finish");
  const other = start("other", "2026-11-03", "https://github.com/example/api");
  expect(launchRepositoryStarts([old, other, failed], "example/web")).toEqual({
    matches: [failed, old],
    others: [other],
    preferred: old,
  });
  expect(launchRepositoryStarts([failed, other], "example/web").preferred).toBe(failed);
  expect(launchRepositoryStarts([other], "example/web").preferred).toBeUndefined();
});

test("selects the directory recorded by the matching snapshot", () => {
  const target = start("custom-folder", "2026-11-01", "git@github.com:example/web.git");
  expect(launchRepositoryFolder(target, "example/web")).toBe("custom-folder");
  expect(launchRepositoryFolder(target, "example/api")).toBeUndefined();
});

test("only templates whose snapshot contains the chosen repository are offered", () => {
  const web = start("web", "2026-11-01", "https://github.com/acme/web");
  const api = start("api", "2026-11-01", "https://github.com/acme/api");
  const template = (id: string) => ({
    id,
    orgId: "org",
    name: id,
    revision: 1,
    goldenName: id,
    repositories: [],
    tools: [],
    blocker: null,
    agent: "Claude",
    definition: {
      provider: "boat" as const,
      goldenId: id,
      harness: "claude" as const,
      model: "opus",
      reasoningEffort: "high",
      variables: [],
      connections: [],
      skills: [],
    },
  });
  const templates = [template("web"), template("api")];
  expect(launchRepositoryTemplates(templates, [web, api], "acme/web", api).map(({ id }) => id)).toEqual(["web"]);
});
