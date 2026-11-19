import { expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { resetPreservedActionForm, usePreservedActionForm } from "./use-preserved-action-form";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe() {
  return createElement("form", { ref: usePreservedActionForm() });
}

test("an explicit successful reset never leaves later mutation drafts unprotected and secrets clear on every attempt", async () => {
  const secret = { value: "private_input" };
  const name = { value: "draft_name" };
  const events = new EventTarget();
  const form = Object.assign(events, {
    querySelectorAll: () => [secret],
    reset() {
      const reset = new Event("reset", { cancelable: true });
      events.dispatchEvent(reset);
      if (!reset.defaultPrevented) {
        name.value = "";
        secret.value = "";
      }
    },
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(Probe), { createNodeMock: () => form });
  });

  form.reset();
  expect(name.value).toBe("draft_name");
  expect(secret.value).toBe("");
  resetPreservedActionForm(form as unknown as HTMLFormElement);
  expect(name.value).toBe("");

  name.value = "next_draft";
  secret.value = "next_private_input";
  form.reset();
  expect(name.value).toBe("next_draft");
  expect(secret.value).toBe("");
  await act(async () => renderer.unmount());
});
