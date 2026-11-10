import { describe, expect, test } from "bun:test";
import { done, fail } from "../src/lib/action.ts";
import { addToast, closeToast, type ToastItem, toastFromResult } from "../src/lib/toast.ts";

const ok = (id: number, title = `toast ${id}`) => ({ id, tone: "success" as const, title });

describe("toasts", () => {
  test("an action's result becomes its toast: the message, or the refusal under a title", () => {
    expect(toastFromResult(done("Stop requested."), "Not stopped")).toEqual({
      tone: "success",
      title: "Stop requested.",
    });
    expect(toastFromResult(fail("The sandbox is busy."), "Not stopped")).toEqual({
      tone: "destructive",
      title: "Not stopped",
      description: "The sandbox is busy.",
    });
  });

  test("beyond the limit the oldest open toast closes, and closed ones leave on the next toast", () => {
    let list: ToastItem[] = [];
    for (const id of [1, 2, 3]) list = addToast(list, ok(id));
    list = addToast(list, ok(4));
    expect(list.map((item) => [item.id, item.open])).toEqual([
      [1, false],
      [2, true],
      [3, true],
      [4, true],
    ]);
    list = closeToast(list, 3);
    list = addToast(list, ok(5));
    expect(list.map((item) => [item.id, item.open])).toEqual([
      [2, true],
      [4, true],
      [5, true],
    ]);
  });

  test("the same message twice is shown once, the newer one", () => {
    const list = addToast(addToast([], ok(1, "Account removed.")), ok(2, "Account removed."));
    expect(list.map((item) => item.id)).toEqual([2]);
  });
});
