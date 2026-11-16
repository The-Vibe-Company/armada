import { describe, expect, test } from "bun:test";
import { modalError } from "../src/errors.ts";

describe("Modal gRPC error classification", () => {
  test.each([
    [16, "unauthorized", false],
    [7, "forbidden", false],
    [14, "unavailable", true],
    [4, "unavailable", true],
    [8, "unavailable", true],
    [3, "invalid_request", false],
    [5, "not_found", false],
    [6, "conflict", false],
    [2, "unknown", false],
    [0, "unknown", false],
  ] as const)("normalizes gRPC status %s without retaining upstream payloads", (status, code, retryable) => {
    const upstream = Object.assign(new Error("private_payload"), {
      name: "ClientError",
      code: status,
      cause: { credential: "private_payload" },
    });
    const safe = modalError(upstream);
    expect(safe.code).toBe(code);
    expect(safe.retryable).toBe(retryable);
    expect(safe.status).toBe(status);
    expect(safe.details).toEqual({ modalFailure: "grpc" });
    expect(safe.message).toContain("consult the durable lifecycle phase before retrying");
    expect(JSON.stringify(safe)).not.toContain("private_payload");
    expect(safe.cause).toBeUndefined();
  });

  test.each([-1, 17, 14.5, "14", undefined, Number.NaN])("rejects invalid gRPC status %s", (code) => {
    const safe = modalError(Object.assign(new Error("private_payload"), { name: "ClientError", code }));
    expect(safe.code).toBe("unknown");
    expect(safe.retryable).toBe(false);
    expect(safe.status).toBeUndefined();
  });
});
