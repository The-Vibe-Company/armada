import { describe, expect, test } from "bun:test";
import { isActiveLink, NAV_GROUPS, organizationSwitchDestination, showsOrganizations } from "../src/lib/navigation.ts";

describe("sidebar navigation", () => {
  test("lists the owner's groups and destinations in order", () => {
    expect(NAV_GROUPS.map((group) => [group.label, group.links.map((link) => link.label)])).toEqual([
      ["Running", ["Sandboxes", "Routines"]],
      ["Launch from", ["Templates", "Snapshots"]],
      ["What agents have", ["Models", "Tools", "Skills", "Variables"]],
      ["Setup", ["Machines", "Organization", "Your connections"]],
    ]);
  });

  test("marks a page and the pages under it active, not a sibling sharing a prefix", () => {
    expect(isActiveLink("/routines", "/routines")).toBe(true);
    expect(isActiveLink("/routines/abc", "/routines")).toBe(true);
    expect(isActiveLink("/routinesx", "/routines")).toBe(false);
  });

  test("always offers Machines so cloud accounts remain accessible without Docker hosts", () => {
    const machines = NAV_GROUPS.flatMap((group) => group.links).find((link) => link.label === "Machines");
    expect(machines?.href).toBe("/providers/cloud");
    expect(machines?.optIn).toBeUndefined();
  });

  test("shows organizations only to a member of several, or to someone with none", () => {
    expect(showsOrganizations(1, true)).toBe(false);
    expect(showsOrganizations(2, true)).toBe(true);
    expect(showsOrganizations(0, false)).toBe(true);
  });
});

describe("organization switch destination", () => {
  test.each([
    ["/routines", "/routines"],
    ["/templates/template_old", "/templates"],
    ["/skills/skill_old", "/skills"],
    ["/variables", "/variables"],
    ["/providers/cloud", "/providers/cloud"],
    ["/hosts/host_old", "/providers/cloud"],
    ["/snapshots/snapshot_old", "/snapshots"],
    ["/harness", "/harness"],
    ["/tools", "/tools"],
    ["/settings", "/settings"],
    ["/orgs/org_old/members", "/orgs/org_new"],
    ["/sandboxes/sandbox_old", "/sandboxes"],
    ["/unknown", "/sandboxes"],
    ["/constructor", "/sandboxes"],
    ["//external.example", "/sandboxes"],
    ["/routines-other", "/sandboxes"],
    ["setup", "/providers/cloud"],
    ["orgs", "/orgs/org_new"],
    ["environments", "/snapshots"],
    ["goldens", "/snapshots"],
    ["credentials", "/harness"],
    ["connections", "/tools"],
  ])("switches from %s to %s without old organization item IDs", (pathname, expected) => {
    expect(organizationSwitchDestination(pathname, "org_new")).toBe(expected);
  });
});
