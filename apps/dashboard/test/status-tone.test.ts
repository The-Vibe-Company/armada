import { expect, test } from "bun:test";
import { statusLook } from "../src/lib/status-tone.ts";

test("each sandbox status has one meaning: in flight, live, in transition, failed or at rest", () => {
  const looks = ["starting", "ready", "running", "stopping", "stopped", "failed", "deleted"].map((status) => [
    status,
    statusLook(status).tone,
    statusLook(status).pulse,
    statusLook(status).label,
  ]);
  expect(looks).toEqual([
    ["starting", "warning", true, "Starting"],
    ["ready", "success", false, "Ready"],
    ["running", "info", true, "Running"],
    ["stopping", "warning", true, "Stopping"],
    ["stopped", "neutral", false, "Stopped"],
    ["failed", "destructive", false, "Failed"],
    ["deleted", "neutral", false, "Deleted"],
  ]);
});

test("a status the dashboard does not know yet is shown as itself, at rest", () => {
  expect(statusLook("hibernating")).toEqual({ tone: "neutral", pulse: false, label: "Hibernating" });
  expect(statusLook("")).toEqual({ tone: "neutral", pulse: false, label: "Unknown" });
});
