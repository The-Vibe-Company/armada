import { expect, test } from "bun:test";
import { clientMutation, UNCONFIRMED_MUTATION } from "./client-mutation";

test("a lost mutation reply becomes an unconfirmed local failure without retrying or echoing secrets", async () => {
  let calls = 0;
  const result = await clientMutation(async () => {
    calls++;
    throw new Error("private_submitted_value");
  });
  expect(result).toEqual({ ok: false, error: UNCONFIRMED_MUTATION, pending: true, unconfirmed: true });
  expect(calls).toBe(1);
});

test("structured refusal and success results are preserved", async () => {
  for (const result of [
    { ok: true, message: "Saved" },
    { ok: false, error: "Name required" },
  ] as const) {
    expect(await clientMutation(async () => result)).toBe(result);
  }
});

test("intentional Next redirects propagate rather than reporting an unconfirmed write", async () => {
  const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/variables;303;" });
  expect(
    clientMutation(async () => {
      throw redirect;
    }),
  ).rejects.toBe(redirect);
});
