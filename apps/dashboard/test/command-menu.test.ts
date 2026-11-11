import { expect, test } from "bun:test";
import { COMMANDS, matchCommands, modifierKey } from "../src/lib/command-menu.ts";

const labels = (query: string) => matchCommands(query).map((command) => command.label);

test("an empty query lists every command in order", () => {
  expect(labels("  ")).toEqual(COMMANDS.map((command) => command.label));
});

test("a label that starts with the query ranks before a word, a keyword and a substring", () => {
  // "Settings" starts with "se"; "Connect a sandbox provider" has no word starting with it, nor "Sandboxes".
  expect(labels("SE")[0]).toBe("Settings");
  // A word inside a label: "Launch a sandbox" (word "sandbox") comes after "Sandboxes" (label start).
  expect(labels("sandbox")).toEqual(["Sandboxes", "Launch a sandbox", "Connect a sandbox provider"]);
  // A keyword only: "mcp" finds Tools.
  expect(labels("mcp")).toEqual(["Tools"]);
  // A substring anywhere, last.
  expect(labels("ness")).toEqual(["Harness"]);
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
