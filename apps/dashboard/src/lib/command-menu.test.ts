import { expect, test } from "bun:test";
import { COMMANDS, commandsForOrganization, matchCommands, modifierKey } from "./command-menu.ts";
import { NAV_GROUPS } from "./navigation";

const labels = (query: string) => matchCommands(query).map((command) => command.label);

test("an empty query lists every command in order", () => {
  expect(labels("  ")).toEqual(COMMANDS.map((command) => command.label));
});

test("a label that starts with the query ranks before a word, a keyword and a substring", () => {
  expect(labels("YOUR")[0]).toBe("Your connections");

  expect(labels("sandbox")).toEqual(["Sandboxes", "Launch a sandbox", "Connect a sandbox provider"]);

  expect(labels("mcp")).toEqual(["Tools"]);

  expect(labels("odel")).toEqual(["Add a model account", "Models"]);

  expect(labels("harness")).toEqual(["Models"]);
});

test("actions and destinations route to current pages and match docker, model account, and API key searches", () => {
  expect(COMMANDS.find((command) => command.id === "launch")?.href).toBe("/sandboxes");
  expect(matchCommands("subscription").some((command) => command.id === "add-account")).toBe(true);
  expect(matchCommands("model account")[0]?.id).toBe("add-account");
  expect(matchCommands("api keys").some((command) => command.href === "/settings/api-keys")).toBe(true);
  for (const query of ["docker", "host", "machine"]) {
    expect(matchCommands(query).some((command) => command.id === "connect-provider")).toBe(true);
  }
});

test("nothing matches an unknown word", () => {
  expect(matchCommands("zzz")).toEqual([]);
});

test("shortcuts name ⌘ on Apple systems and Ctrl elsewhere", () => {
  expect(modifierKey("MacIntel")).toBe("⌘");
  expect(modifierKey("iPhone")).toBe("⌘");
  expect(modifierKey("Win32")).toBe("Ctrl");
  expect(modifierKey("Linux x86_64")).toBe("Ctrl");
  expect(modifierKey("")).toBe("Ctrl");
});

test("every visible destination is searchable by its navigation label, with historical aliases retained", () => {
  for (const group of NAV_GROUPS) {
    for (const link of group.links) {
      expect(matchCommands(link.label).some((command) => command.group === "Go to" && command.href === link.href)).toBe(
        true,
      );
    }
  }
  expect(matchCommands("providers").some((command) => command.href === "/providers/cloud")).toBe(true);
  expect(matchCommands("Cloud providers").some((command) => command.href === "/providers/cloud")).toBe(true);
  expect(matchCommands("Settings").some((command) => command.href === "/settings")).toBe(true);
});

test("webhook search offers inbound triggers only to organization admins", () => {
  expect(matchCommands("webhook", commandsForOrganization(true)).map((command) => command.href)).toEqual(["/triggers"]);
  expect(matchCommands("webhook", commandsForOrganization(false))).toEqual([]);
});
