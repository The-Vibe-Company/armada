import { describe, expect, test } from "bun:test";
import { isActiveLink, NAV_GROUPS, showsOrganizations } from "../src/lib/navigation.ts";

describe("sidebar navigation", () => {
  test("lists the owner's groups and destinations in order, without Organizations", () => {
    expect(NAV_GROUPS.map((group) => [group.label, group.links.map((link) => link.label)])).toEqual([
      ["Run", ["Sandboxes", "Otto", "Routines", "Templates"]],
      ["Library", ["Environments", "Skills", "Tools", "Variables"]],
      ["Providers", ["Self-hosted", "Cloud"]],
      ["Account", ["Models", "Settings"]],
    ]);
  });

  test("marks a page and the pages under it active, not a sibling sharing a prefix", () => {
    expect(isActiveLink("/routines", "/routines")).toBe(true);
    expect(isActiveLink("/routines/abc", "/routines")).toBe(true);
    expect(isActiveLink("/routinesx", "/routines")).toBe(false);
  });

  test("hides Self-hosted behind the Docker hosts opt-in, but never Cloud", () => {
    const providers = NAV_GROUPS.find((group) => group.label === "Providers");
    expect(providers?.links.find((link) => link.label === "Self-hosted")?.optIn).toBe("dockerHosts");
    expect(providers?.links.find((link) => link.label === "Cloud")?.optIn).toBeUndefined();
  });

  test("shows organizations only to a member of several, or to someone with none", () => {
    expect(showsOrganizations(1, true)).toBe(false);
    expect(showsOrganizations(2, true)).toBe(true);
    expect(showsOrganizations(0, false)).toBe(true);
  });
});
