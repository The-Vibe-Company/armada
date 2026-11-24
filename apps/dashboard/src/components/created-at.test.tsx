import { expect, jest, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { CreatedAt } from "./created-at";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("creation ages share one interval until the last timestamp unmounts", () => {
  jest.useFakeTimers();
  const now = Date.now();
  const clocks = (second: boolean) => (
    <>
      <CreatedAt iso="" now={now} />
      {second && <CreatedAt iso="" now={now} />}
    </>
  );
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(clocks(true));
    });
    expect(jest.getTimerCount()).toBe(1);

    act(() => renderer?.update(clocks(false)));
    expect(jest.getTimerCount()).toBe(1);
  } finally {
    try {
      act(() => renderer?.unmount());
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  }
});
