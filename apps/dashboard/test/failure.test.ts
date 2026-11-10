import { expect, test } from "bun:test";
import { describeFailure } from "../src/lib/failure.ts";

test("usage_limit and auth_expiry have a clear message and a place to fix them", () => {
  expect(describeFailure("usage_limit")).toMatchObject({ title: "Usage limit reached", fix: { href: "/harness" } });
  expect(describeFailure("auth_expiry")).toMatchObject({ title: "Account expired", fix: { href: "/harness" } });
});

test("provider error codes map to the same messages, and unknown reasons have none", () => {
  expect(describeFailure("payment_required")?.title).toBe("Usage limit reached");
  expect(describeFailure("unauthorized")?.title).toBe("Account expired");
  expect(describeFailure("claude failed: auth_expiry (401)")).toBeNull();
  expect(describeFailure("credential_refused")?.fix?.href).toBe("/harness");
  expect(describeFailure("provider_unavailable")?.title).toBe("Provider unavailable");
  expect(describeFailure("dependency_unavailable")?.title).toBe("Server dependency unavailable");
  expect(describeFailure("outcome_unknown")?.hint).toContain("before retrying");
  expect(describeFailure("segfault")).toBeNull();
  expect(describeFailure(null)).toBeNull();
});
