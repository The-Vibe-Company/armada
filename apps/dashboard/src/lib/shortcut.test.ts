import { expect, test } from "bun:test";
import { isSubmitShortcut } from "./shortcut.ts";

test("⌘↵ and Ctrl+↵ submit; Enter alone, with Shift or Alt, or while composing does not", () => {
  const keys = { key: "Enter", metaKey: false, ctrlKey: false };
  expect(isSubmitShortcut({ ...keys, metaKey: true })).toBe(true);
  expect(isSubmitShortcut({ ...keys, ctrlKey: true })).toBe(true);
  expect(isSubmitShortcut(keys)).toBe(false);
  expect(isSubmitShortcut({ ...keys, metaKey: true, shiftKey: true })).toBe(false);
  expect(isSubmitShortcut({ ...keys, ctrlKey: true, altKey: true })).toBe(false);
  expect(isSubmitShortcut({ ...keys, metaKey: true, isComposing: true })).toBe(false);
  expect(isSubmitShortcut({ ...keys, key: "a", metaKey: true })).toBe(false);
});
