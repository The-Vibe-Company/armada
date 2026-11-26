import { expect, test } from "bun:test";
import { isSubmitShortcut, shouldIgnoreGlobalShortcut } from "./shortcut.ts";

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

test("single-key global shortcuts ignore editable targets and modifiers, while allowing Shift when opted in", () => {
  const base = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null };
  expect(shouldIgnoreGlobalShortcut(base)).toBe(false);
  expect(shouldIgnoreGlobalShortcut({ ...base, metaKey: true })).toBe(true);
  expect(shouldIgnoreGlobalShortcut({ ...base, shiftKey: true })).toBe(true);
  expect(shouldIgnoreGlobalShortcut({ ...base, shiftKey: true }, { allowShift: true })).toBe(false);
  expect(shouldIgnoreGlobalShortcut({ ...base, target: { tagName: "INPUT" } as unknown as EventTarget })).toBe(true);
  expect(shouldIgnoreGlobalShortcut({ ...base, target: { tagName: "TEXTAREA" } as unknown as EventTarget })).toBe(true);
  expect(shouldIgnoreGlobalShortcut({ ...base, target: { isContentEditable: true } as unknown as EventTarget })).toBe(
    true,
  );
  expect(shouldIgnoreGlobalShortcut({ ...base, repeat: true })).toBe(true);
});
