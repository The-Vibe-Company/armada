import { expect, test } from "bun:test";
import { goldenRepositoryDirs, repositoryChoice, sandboxRepositoryDir } from "../src/lib/repository-context.ts";

test("the choices are exactly the golden config's repository directories, as the server derives them", () => {
  const config = {
    repos: [
      { url: "https://github.com/acme/web.git", branch: "main" },
      { url: "https://github.com/acme/tools.git", branch: "main", dir: "api" },
    ],
    init: [],
  };
  expect(goldenRepositoryDirs(config)).toEqual(["web", "api"]);
  expect(goldenRepositoryDirs({})).toEqual([]);
  expect(goldenRepositoryDirs({ repos: [{ url: "https://x.example/a.git", branch: "main", dir: "../a" }] })).toEqual(
    [],
  );
});

test("a repository choice is the default (none sent) or one listed directory", () => {
  const dirs = ["web", "api"];
  expect(repositoryChoice("", dirs)).toEqual({ ok: true, repo: undefined });
  expect(repositoryChoice("api", dirs)).toEqual({ ok: true, repo: "api" });
  for (const forged of ["../web", "/srv/web", "Web", "docs"]) expect(repositoryChoice(forged, dirs).ok).toBe(false);
});

test("a sandbox shows its recorded repository context only when there is one", () => {
  expect(sandboxRepositoryDir({ repository_dir: "api" })).toBe("api");
  expect(sandboxRepositoryDir({ repository_dir: null })).toBeNull();
  expect(sandboxRepositoryDir({})).toBeNull();
});
