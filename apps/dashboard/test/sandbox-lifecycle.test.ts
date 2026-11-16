import { expect, test } from "bun:test";
import { lifecycleFailure } from "../src/lib/sandbox-lifecycle.ts";

test("unconfirmed lifecycle operations direct observation before retry, never assert mutation failed", () => {
  for (const status of [undefined, 408, 409, 502]) {
    expect(lifecycleFailure("stop", { status })).toContain(
      "Reload this sandbox to check its current state before trying again",
    );
    expect(lifecycleFailure("delete", { status })).toContain(
      "Reload the sandbox list to check whether it was removed before trying again",
    );
  }
});

test("lifecycle access failures offer sign-in or administrator recovery", () => {
  for (const operation of ["stop", "delete"] as const)
    for (const status of [401, 403]) expect(lifecycleFailure(operation, { status })).toContain("Sign in again");
});

test("definite lifecycle refusals retain their cause without exposing diagnostics", () => {
  for (const operation of ["stop", "delete"] as const) {
    expect(lifecycleFailure(operation, { code: "not_found" })).toContain("not found");
    expect(lifecycleFailure(operation, { code: "conflict" })).toContain("could not be confirmed");
    expect(lifecycleFailure(operation, { status: 400 })).toContain("was refused");
  }
});

// Only known pre-dispatch refusals are definite; unknown conflicts can be pending cleanup.
test("delete conflicts retain known pre-dispatch recovery without echoing unknown messages", () => {
  for (const message of ["Stop the sandbox before deleting it.", "Stop the Docker sandbox before deleting it."])
    expect(lifecycleFailure("delete", { code: "conflict", message })).toContain("Stop the sandbox, then delete it.");
  expect(
    lifecycleFailure("delete", {
      status: 409,
      message: "Managed orchestrators have their own lifecycle; delete an ordinary delegated parent before its child.",
    }),
  ).toContain("Delete its delegated parent");
  const unknown = lifecycleFailure("delete", { status: 409, message: "private upstream diagnostic" });
  expect(unknown).toContain("could not be confirmed");
  expect(unknown).not.toContain("private upstream diagnostic");
});
