import { expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { usePreservedActionForm } from "../src/components/use-preserved-action-form";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe({ preserve }: { preserve: boolean }) {
  return createElement("form", { ref: usePreservedActionForm(preserve) });
}

test("mutation form reset preserves the draft, clears one-attempt secrets, and allows an explicit successful reset", async () => {
  const secret = { value: "private_input" };
  const form = Object.assign(new EventTarget(), { querySelectorAll: () => [secret] });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(Probe, { preserve: true }), { createNodeMock: () => form });
  });
  const reset = new Event("reset", { cancelable: true });
  form.dispatchEvent(reset);
  expect(reset.defaultPrevented).toBe(true);
  expect(secret.value).toBe("");
  await act(async () => {
    renderer.update(createElement(Probe, { preserve: false }));
  });
  const successfulReset = new Event("reset", { cancelable: true });
  form.dispatchEvent(successfulReset);
  expect(successfulReset.defaultPrevented).toBe(false);
  await act(async () => renderer.unmount());
});
