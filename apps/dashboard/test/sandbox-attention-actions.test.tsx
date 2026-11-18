import { expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SandboxAttentionActions } from "../src/components/sandbox-attention-actions";

// React's renderer exercises reconciliation without a browser or server request.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test.each(["interrupted", "unconcluded"] as const)(
  "%s recovery retains retry identity but replaces it for a new attention episode",
  async (attention) => {
    const props = {
      sandboxId: "sandbox_one",
      name: "sandbox",
      status: "running" as const,
      configured: true,
      busy: false,
      attention,
      resend: "original instruction",
      ackKey: "episode_one",
      dismissed: false,
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(SandboxAttentionActions, props));
    });
    const key = () => renderer.root.findByProps({ name: "send_key" }).props.value;
    const original = key();
    await act(async () => {
      renderer.update(createElement(SandboxAttentionActions, { ...props }));
    });
    expect(key()).toBe(original);
    await act(async () => {
      renderer.update(createElement(SandboxAttentionActions, { ...props, ackKey: "episode_two" }));
    });
    expect(key()).not.toBe(original);
    await act(async () => {
      renderer.unmount();
    });
  },
);

test("interrupted recovery replaces identity for changed submitted input within an episode", async () => {
  const props = {
    sandboxId: "sandbox_one",
    name: "sandbox",
    status: "running" as const,
    configured: true,
    busy: false,
    attention: "interrupted" as const,
    resend: "original instruction",
    ackKey: "episode_one",
    dismissed: false,
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(SandboxAttentionActions, props));
  });
  const key = () => renderer.root.findByProps({ name: "send_key" }).props.value;
  const original = key();
  await act(async () => {
    renderer.update(createElement(SandboxAttentionActions, { ...props, resend: "changed instruction" }));
  });
  expect(key()).not.toBe(original);
  const fields = renderer.root.findAllByType("input").map(({ props }) => [props.name, props.value]);
  expect(Object.fromEntries(fields)).toEqual({
    send_key: key(),
    sandbox: props.sandboxId,
    prompt: "changed instruction",
  });
  await act(async () => {
    renderer.unmount();
  });
});
