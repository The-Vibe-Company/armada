import { expect, test } from "bun:test";
import { createElement, startTransition } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useMutationState } from "../src/components/use-mutation-state";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("lost replies retain specialized confirmed state and expose an unconfirmed failure without replay", async () => {
  type Result = { ok: true; hostId: string } | { ok: false; error: string };
  const previous: (Result | null)[] = [];
  const saved: Result = { ok: true, hostId: "host_one" };
  const action = async (state: Result | null) => {
    previous.push(state);
    if (previous.length === 2) throw new Error("lost_reply");
    return saved;
  };
  function Probe() {
    const [result, submit] = useMutationState(action);
    return createElement("form", { action: submit, "data-result": result });
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(Probe));
  });
  const submit = async () => {
    await act(async () => {
      startTransition(() => renderer.root.findByType("form").props.action(new FormData()));
    });
  };
  await submit();
  expect(renderer.root.findByType("form").props["data-result"]).toEqual(saved);
  await submit();
  expect(renderer.root.findByType("form").props["data-result"]).toMatchObject({ ok: false, unconfirmed: true });
  expect(previous).toEqual([null, saved]);
  await submit();
  expect(previous).toEqual([null, saved, saved]);
  await act(async () => renderer.unmount());
});
