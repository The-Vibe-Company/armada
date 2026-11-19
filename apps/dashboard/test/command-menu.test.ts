import { expect, test } from "bun:test";
import { COMMANDS, commandsForOrganization, matchCommands, modifierKey } from "../src/lib/command-menu.ts";
import { NAV_GROUPS } from "../src/lib/navigation";

const labels = (query: string) => matchCommands(query).map((command) => command.label);

test("an empty query lists every command in order", () => {
  expect(labels("  ")).toEqual(COMMANDS.map((command) => command.label));
});

test("a label that starts with the query ranks before a word, a keyword and a substring", () => {
  // A visible label prefix outranks keyword matches.
  expect(labels("YOUR")[0]).toBe("Your connections");
  // A word inside a label: "Launch a sandbox" (word "sandbox") comes after "Sandboxes" (label start).
  expect(labels("sandbox")).toEqual(["Sandboxes", "Launch a sandbox", "Connect a sandbox provider"]);
  // A keyword only: "mcp" finds Tools.
  expect(labels("mcp")).toEqual(["Tools"]);
  // A substring anywhere, last.
  expect(labels("odel")).toEqual(["Models"]);
  // The old page name remains searchable without keeping it in the menu.
  expect(labels("harness")).toEqual(["Models"]);
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
