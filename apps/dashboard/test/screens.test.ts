import { expect, test } from "bun:test";
import { goldenLaunchReadiness } from "../src/lib/golden-form.ts";
import { initialOf, roleChange } from "../src/lib/members.ts";
import { isSubmitShortcut } from "../src/lib/shortcut.ts";
import { connectionLook } from "../src/lib/status-tone.ts";

test("a golden's launch state names the first thing that holds it, in the tone of its cause", () => {
  const base = { provider: "modal" as const, hasSnapshot: true, serverReady: true, connected: ["modal" as const] };
  const look = (overrides: Partial<typeof base> | { connected: null | "boat"[] }) => {
    const state = goldenLaunchReadiness({ ...base, ...overrides });
    return state.kind === "ready" ? "ready" : [state.kind, state.tone, state.label, state.detail, state.connect];
  };
  expect(look({})).toBe("ready");
  // Without a snapshot nothing else matters yet: building it is the next step.
  expect(look({ hasSnapshot: false, serverReady: false, connected: null })).toEqual([
    "no-snapshot",
    "warning",
    "Needs a snapshot",
    "Build it before launching from it.",
    false,
  ]);
  expect(look({ serverReady: false })).toEqual([
    "no-server",
    "destructive",
    "Server not configured",
    "Launching needs the Armada server.",
    false,
  ]);
  expect(look({ connected: null })).toEqual([
    "provider-unknown",
    "warning",
    "Launch paused",
    "The provider status is unavailable.",
    false,
  ]);
  // Another provider connected does not launch this golden: it lives on Modal for good.
  expect(look({ connected: ["boat"] })).toEqual([
    "provider-missing",
    "neutral",
    "Modal not connected",
    "Connect Modal in Settings to launch.",
    true,
  ]);
});

test("a connection is live, at rest, failed or in doubt, never two at once", () => {
  expect(
    (["connected", "not-connected", "revoked", "unavailable"] as const).map((state) => [
      connectionLook(state).tone,
      connectionLook(state).label,
    ]),
  ).toEqual([
    ["success", "Connected"],
    ["neutral", "Not connected"],
    ["destructive", "Revoked"],
    ["warning", "Unavailable"],
  ]);
});

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

test("only giving up your own admin role asks first; an unchanged role saves nothing", () => {
  expect(roleChange("admin", "admin", true)).toBe("none");
  expect(roleChange("admin", "member", true)).toBe("self-demote");
  expect(roleChange("admin", "member", false)).toBe("change");
  expect(roleChange("member", "admin", false)).toBe("change");
  expect(roleChange("member", "admin", true)).toBe("change");
});

test("a member's avatar shows the first letter or digit of their email", () => {
  expect(initialOf("alice@example.com")).toBe("A");
  expect(initialOf("_7bob@example.com")).toBe("7");
  expect(initialOf("@@")).toBe("•");
});
