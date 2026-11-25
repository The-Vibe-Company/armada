import { expect, jest, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CreatedAt } from "./created-at";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("creation ages share one interval until the last timestamp unmounts", () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-01-01T00:05:00Z"));
  const now = Date.now();
  const iso = "2025-01-01T00:00:00Z";
  const clocks = (second: boolean) => (
    <TooltipProvider>
      <CreatedAt iso={iso} now={now} />
      {second && <CreatedAt iso={iso} now={now} />}
    </TooltipProvider>
  );
  // oxlint-disable-next-line landmines-testing/no-test-doubles -- Supply Radix cleanup globals for the real tooltip tree in the DOM-free renderer.
  Object.assign(globalThis, { window: { clearTimeout }, document: new EventTarget() });
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(clocks(true));
    });
    expect(renderer?.root.findAllByType(TooltipProvider)).toHaveLength(1);
    const times = renderer?.root.findAllByType("time");
    expect(times?.map(({ props }) => [props.dateTime, props.children])).toEqual([
      [iso, "5 min ago"],
      [iso, "5 min ago"],
    ]);
    expect(jest.getTimerCount()).toBe(1);

    act(() => renderer?.update(clocks(false)));
    expect(jest.getTimerCount()).toBe(1);
  } finally {
    try {
      act(() => renderer?.unmount());
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      /* oxlint-disable landmines-testing/no-test-doubles -- Restore the DOM-free test environment. */
      Reflect.deleteProperty(globalThis, "window");
      Reflect.deleteProperty(globalThis, "document");
      /* oxlint-enable landmines-testing/no-test-doubles */
      jest.useRealTimers();
    }
  }
});
