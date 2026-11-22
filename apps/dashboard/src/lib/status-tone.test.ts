import { expect, test } from "bun:test";
import { connectionLook, statusLook } from "./status-tone.ts";

test("each sandbox status has one meaning: in flight, live, in transition, failed or at rest", () => {
  const looks = ["starting", "ready", "running", "stopping", "stopped", "failed", "deleted"].map((status) => [
    status,
    statusLook(status).tone,
    statusLook(status).pulse,
    statusLook(status).label,
  ]);
  expect(looks).toEqual([
    ["starting", "neutral", true, "Starting"],
    ["ready", "warning", false, "Waiting for you"],
    ["running", "success", true, "Working"],
    ["stopping", "neutral", true, "Stopping"],
    ["stopped", "neutral", false, "Stopped"],
    ["failed", "destructive", false, "Failed"],
    ["deleted", "neutral", false, "Deleted"],
  ]);
});

test("a status the dashboard does not know yet is shown as itself, at rest", () => {
  expect(statusLook("hibernating")).toEqual({ tone: "neutral", pulse: false, label: "Hibernating" });
  expect(statusLook("")).toEqual({ tone: "neutral", pulse: false, label: "Unknown" });
});

test("a connection is live, at rest, failed or in doubt, never two at once", () => {
  expect(
    (["connected", "not-connected", "revoked", "unavailable"] as const).map((state) => [
      connectionLook(state).tone,
      connectionLook(state).label,
    ]),
  ).toEqual([
    ["success", "Connected"],
    ["neutral", "Not connected"],
    ["destructive", "Revoked"],
    ["warning", "Unavailable"],
  ]);
});
