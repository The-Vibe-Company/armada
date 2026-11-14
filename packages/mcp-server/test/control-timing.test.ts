import { expect, test } from "bun:test";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";

test("control failures expose durations without credentials or error text", async () => {
  // Missing bearer fails before any store, provider or network access.
  const response = await handleControlRequest(
    new Request("https://armada.test/api/v1/sandbox/list", { method: "POST" }),
    {} as ControlOptions,
  );
  expect(response?.status).toBe(401);
  expect(response?.headers.get("server-timing")).toMatch(/^auth;dur=\d+\.\d{2}, total;dur=\d+\.\d{2}$/);
});
