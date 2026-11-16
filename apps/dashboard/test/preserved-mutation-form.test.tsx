import { expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { resetPreservedActionForm, usePreservedActionForm } from "../src/components/use-preserved-action-form";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe() {
  return createElement("form", { ref: usePreservedActionForm() });
}

test("an explicit successful reset never leaves later mutation drafts unprotected and secrets clear on every attempt", async () => {
  const secret = { value: "private_input" };
  const name = { value: "draft_name" };
  const form = Object.assign(new EventTarget(), {
    querySelectorAll: () => [secret],
    reset() {
      const reset = new Event("reset", { cancelable: true });
      this.dispatchEvent(reset);
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
  // React's normal post-action reset is cancelled, but one-attempt secrets are cleared.
  form.reset();
  expect(name.value).toBe("draft_name");
  expect(secret.value).toBe("");
  resetPreservedActionForm(form as unknown as HTMLFormElement);
  expect(name.value).toBe("");
  // A draft entered after success must survive the next native action reset, before effects can run.
  name.value = "next_draft";
  secret.value = "next_private_input";
  form.reset();
  expect(name.value).toBe("next_draft");
  expect(secret.value).toBe("");
  await act(async () => renderer.unmount());
});
