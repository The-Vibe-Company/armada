import { describe, expect, test } from "bun:test";
import {
  boatCapacity,
  editDefaults,
  goldenRequest,
  goldenRowState,
  launchRepoOptions,
  repoSlug,
} from "../src/lib/golden-form.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const base = { mode: "create", name: "web", org: ORG, visibility: "org", init: "", setup: "" };
const row = (url: string, branch = "", dir = "") => ({ url, branch, dir });

describe("the golden form request", () => {
  test("several repositories become one config with branch, directory, init and setup", () => {
    const parsed = goldenRequest({
      ...base,
      repos: [row("acme/web", "develop", "app"), row("https://github.com/acme/api.git"), row("", "", "")],
      init: "bun install\n\n  make deps  ",
      setup: "echo ready",
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        mode: "create",
        body: {
          name: "web",
          org: ORG,
          private: false,
          provider: "boat",
          config: {
            repos: [
              { url: "https://github.com/acme/web.git", branch: "develop", dir: "app" },
              { url: "https://github.com/acme/api.git", branch: "main" },
            ],
            init: ["bun install", "make deps"],
          },
          setup: "echo ready",
        },
      },
    });
  });

  test("a rebuild sends no visibility: the server keeps the stored one", () => {
    const parsed = goldenRequest({ ...base, mode: "update", visibility: "", repos: [row("acme/web")] });
    expect(parsed.ok && parsed.value.body).toEqual({
      name: "web",
      org: ORG,
      provider: "boat",
      config: { repos: [{ url: "https://github.com/acme/web.git", branch: "main" }], init: [] },
    });
    expect(parsed.ok && "private" in parsed.value.body).toBe(false);
  });

  test("mistakes the server would refuse are reported before a builder starts", () => {
    const error = (fields: Partial<Parameters<typeof goldenRequest>[0]>) => {
      const parsed = goldenRequest({ ...base, repos: [row("acme/web")], ...fields });
      return parsed.ok ? null : parsed.error;
    };
    expect(error({ repos: [] })).toBe("Add at least one repository.");
    expect(error({ repos: [row("", "dev")] })).toBe("Repository 1 needs a GitHub repository.");
    expect(error({ repos: [row("https://gitlab.com/acme/web.git")] })).toContain("GitHub repository");
    expect(error({ repos: [row("https://user:pw@github.com/acme/web.git")] })).toContain("credentials");
    expect(error({ repos: [row("acme/web", "-bad")] })).toContain("not a branch name");
    expect(error({ repos: [row("acme/web", "", "a/b")] })).toContain("single path segment");
    expect(error({ repos: [row("acme/web", "", "x"), row("acme/api", "", "x")] })).toBeTruthy();
    expect(error({ init: "export GITHUB_TOKEN=abc" })).toContain("secrets");
    expect(error({ name: "  " })).toContain("1 to 120");
    expect(error({ visibility: "public" })).toBe("Choose who sees the golden.");
    expect(error({ repos: Array.from({ length: 17 }, (_, i) => row(`acme/r${i}`)) })).toContain("at most 16");
    expect(error({ mode: "delete" })).toBe("That request is not valid.");
  });
});

describe("recorded repositories", () => {
  test("owner/repo from https, ssh and scp forms; anything else is not offered", () => {
    expect(repoSlug("https://github.com/acme/web.git")).toBe("acme/web");
    expect(repoSlug("https://github.com/acme/web")).toBe("acme/web");
    expect(repoSlug("git@github.com:acme/web.git")).toBe("acme/web");
    expect(repoSlug("ssh://git@github.com/acme/web.git")).toBe("acme/web");
    expect(repoSlug("https://gitlab.com/acme/web.git")).toBeNull();
  });

  test("the launch choices are the golden's distinct GitHub repositories; a legacy empty config offers none", () => {
    const config = {
      repos: [
        { url: "https://github.com/acme/web.git", branch: "main", dir: "web" },
        { url: "git@github.com:acme/web.git", branch: "dev", dir: "web-2" },
        { url: "https://gitlab.com/x/y.git", branch: "main", dir: "y" },
        { url: "https://github.com/acme/api.git", branch: "main", dir: "api" },
      ],
      init: [],
    };
    expect(launchRepoOptions(config)).toEqual(["acme/web", "acme/api"]);
    expect(launchRepoOptions({})).toEqual([]);
    expect(launchRepoOptions(null)).toEqual([]);
  });

  test("the rebuild form starts from what the golden records", () => {
    expect(
      editDefaults({
        config: { repos: [{ url: "https://github.com/acme/web.git", branch: "dev", dir: "app" }], init: ["a", "b"] },
      }),
    ).toEqual({ repos: [{ url: "acme/web", branch: "dev", dir: "app" }], init: "a\nb" });
    expect(editDefaults({ config: {} })).toEqual({ repos: [{ url: "", branch: "", dir: "" }], init: "" });
  });
});

describe("what the page offers", () => {
  const viewer = { id: "alice", isAdmin: false };
  const golden = (name: string, visibility: "org" | "private", owner = "alice", provider = "boat") => ({
    name,
    visibility,
    owner_id: owner,
    provider: provider as "boat" | "modal",
  });

  test("rebuild follows the owner/admin rule, and a shared name is flagged, not resolved", () => {
    expect(goldenRowState(golden("a", "private"), [golden("a", "private")], viewer).canRebuild).toBe(true);
    expect(goldenRowState(golden("a", "private", "bob"), [], viewer).reason).toContain("owner");
    expect(goldenRowState(golden("a", "org"), [], viewer).reason).toContain("admin");
    expect(goldenRowState(golden("a", "org"), [], { ...viewer, isAdmin: true }).canRebuild).toBe(true);
    expect(goldenRowState(golden("a", "org", "alice", "modal"), [], { ...viewer, isAdmin: true }).canRebuild).toBe(
      false,
    );
    const both = [golden("a", "org"), golden("a", "private")];
    const state = goldenRowState(golden("a", "private"), both, viewer);
    expect(state).toMatchObject({ duplicateName: true, canRebuild: false });
  });

  test("capacity compares visible Boat rows with the provider's own number", () => {
    const boat = { provider: "boat" as const };
    const modal = { provider: "modal" as const };
    expect(boatCapacity([], 1)).toEqual({ kind: "available", capacity: 1, used: 0 });
    expect(boatCapacity([boat, modal], 1)).toEqual({ kind: "full", capacity: 1, used: 1 });
    expect(boatCapacity([boat, boat], 1)).toEqual({ kind: "legacy", capacity: 1, used: 2 });
    expect(boatCapacity([boat], null)).toEqual({ kind: "unknown" });
  });
});
