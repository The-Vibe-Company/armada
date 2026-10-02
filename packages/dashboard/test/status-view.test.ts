import { describe, expect, test } from "bun:test";
import { overviewStatus } from "../lib/status-view.ts";

const figures = (inFlight: number, decide: number, failing: number) => ({ inFlight, decide, failing });

describe("the overview's status sentence", () => {
  test("welcomes a returning viewer with what merged, else counts the agents in flight", () => {
    expect(overviewStatus(figures(11, 4, 2), { merged: 6 }, 0).lead).toEqual({ kind: "away", merged: 6 });
    expect(overviewStatus(figures(11, 4, 2), null, 0).lead).toEqual({ kind: "flight", agents: 11 });
    expect(overviewStatus(figures(0, 0, 0), null, 3).lead).toEqual({ kind: "rest" });
  });

  test("goes on with what waits for the owner, then what fails, then what is ready to start", () => {
    expect(overviewStatus(figures(11, 4, 2), null, 0).then).toEqual({ kind: "decide", n: 4 });
    expect(overviewStatus(figures(11, 0, 2), null, 0).then).toEqual({ kind: "failing", n: 2 });
    expect(overviewStatus(figures(0, 0, 0), null, 3).then).toEqual({ kind: "ready", n: 3 });
    expect(overviewStatus(figures(5, 0, 0), null, 3).then).toEqual({ kind: "calm" });
  });
});
