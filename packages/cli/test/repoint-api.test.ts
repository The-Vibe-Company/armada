import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

// The server owns eligibility/delivery; this boundary protects the API-only transport and visible note.
test("repoint sends only account identifiers and prints the safe server receipt", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const credentialId = "22222222-2222-4222-8222-222222222222";
  const org = "33333333-3333-4333-8333-333333333333";
  const note = "The sandbox account changed. Its workspace and conversations are retained.";
  const calls: Request[] = [];
  let out = "",
    err = "";
  const io = {
    out: (s: string) => {
      out += s;
    },
    err: (s: string) => {
      err += s;
    },
  };
  const auth = {
    ...io,
    env: { ARMADA_TOKEN: "fixture-token", ARMADA_URL: "https://armada.test" },
    session: memorySessionStore(),
    now: () => new Date(),
    open: () => {},
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(input instanceof Request ? new Request(input, init) : new Request(String(input), init));
      return Response.json({ id, credentialId, credentialVersion: 2, status: "bound", note });
    },
  };
  expect(await run(["repoint-credential", id, "--credential-id", credentialId, "--org", org], io, { auth })).toBe(0);
  expect(err).toBe("");
  expect(out).toContain(note);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://armada.test/api/v1/sandbox/repoint-credential");
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.headers.get("authorization")).toBe("Bearer fixture-token");
  expect(await calls[0]?.json()).toEqual({ id, org, credentialId });
  expect(await run(["repoint-credential", id, "--credential-id", "bad-id", "--json"], io, { auth })).toBe(2);
  expect(calls).toHaveLength(1);
});
