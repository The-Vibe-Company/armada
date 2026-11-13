import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const org = "11111111-1111-4111-8111-111111111111";
const hostId = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const start = Date.parse("2026-11-13T00:00:00Z");
const command = "server-returned-copyable-command";
const summary = {
  id: hostId,
  name: "office",
  state: "online",
  createdAt: new Date(start).toISOString(),
  lastSeenAt: new Date(start).toISOString(),
  revokedAt: null,
  version: "2.27.0",
  sandboxes: 3,
};
async function capture(args: string[], fetcher: (request: Request) => Promise<Response>) {
  let out = "",
    err = "",
    now = start,
    slept = 0;
  const code = await run(
    args,
    {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
    {
      auth: {
        out: () => {},
        err: () => {},
        env: { ARMADA_TOKEN: "armada_sk_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12" },
        session: memorySessionStore(),
        now: () => new Date(now),
        open: () => {},
        sleep: async (ms) => {
          now += ms;
          slept += ms;
        },
        preferences: { read: async () => org, write: async () => {} },
        fetch: async (input, init) => fetcher(input instanceof Request ? input : new Request(String(input), init)),
      },
    },
  );
  return { code, out, err, slept };
}
function ticket(expiry = start + 300_000) {
  return { hostId, registrationToken: "a".repeat(64), command, expiresAt: new Date(expiry).toISOString() };
}

// These exercise the API-only CLI, including selected org and the injected clock/sleep.
test("host add prints the server command once, submits its name and waits for this exact host online", async () => {
  let issued = 0,
    listed = 0;
  const result = await capture(["host", "add", "--name", " office "], async (request) => {
    if (new URL(request.url).pathname.endsWith("register-token")) {
      issued++;
      expect(await request.json()).toEqual({ org, name: "office" });
      return Response.json(ticket());
    }
    listed++;
    expect(await request.json()).toEqual({ org });
    return Response.json({
      placement: true,
      hosts:
        listed === 1
          ? [
              { ...summary, id: other },
              { ...summary, state: "pending" },
            ]
          : [summary],
    });
  });
  expect(result.code).toBe(0);
  expect(issued).toBe(1);
  expect(listed).toBe(2);
  expect(result.slept).toBe(2000);
  expect(result.out.split(command)).toHaveLength(2);
  expect(result.out).toContain(`${hostId} is online`);
  expect(result.out).not.toContain("a".repeat(64));
  expect(result.err).toBe("");
});

test("host add pending waits respect token expiry and five-minute limit without reissuing", async () => {
  for (const expiry of [start + 3000, start + 600_000]) {
    let issued = 0;
    const result = await capture(["host", "add"], async (request) => {
      if (new URL(request.url).pathname.endsWith("register-token")) {
        issued++;
        return Response.json(ticket(expiry));
      }
      return Response.json({ placement: true, hosts: [{ ...summary, state: "offline" }] });
    });
    expect(result.code).toBe(1);
    expect(issued).toBe(1);
    expect(result.slept).toBe(Math.min(expiry - start, 300_000));
    expect(result.err).toContain(hostId);
    expect(result.err).toContain("no registration was reissued");
  }
});

test("host list exposes safe metadata as text or JSON and revoke uses host UUID", async () => {
  for (const json of [false, true]) {
    const result = await capture(["host", "list", ...(json ? ["--json"] : [])], async (request) => {
      expect(new URL(request.url).pathname).toEndWith("/hosts/list");
      expect(await request.json()).toEqual({ org });
      return Response.json({ placement: true, hosts: [summary] });
    });
    expect(result.code).toBe(0);
    if (json) expect(JSON.parse(result.out).hosts[0]).toEqual(summary);
    else
      for (const value of ["office", "online", "2.27.0", "3", summary.lastSeenAt]) expect(result.out).toContain(value);
  }
  const revoked = await capture(["host", "revoke", hostId], async (request) => {
    expect(new URL(request.url).pathname).toEndWith("/hosts/revoke");
    expect(await request.json()).toEqual({ org, hostId });
    return Response.json({ revoked: true });
  });
  expect(revoked.code).toBe(0);
  expect(revoked.out).toContain(hostId);
});

test("host add network loss after issue retains host identity without issuing another ticket", async () => {
  let issued = 0;
  const result = await capture(["host", "add"], async (request) => {
    if (new URL(request.url).pathname.endsWith("register-token")) {
      issued++;
      return Response.json(ticket());
    }
    throw Error("offline");
  });
  expect(result.code).not.toBe(0);
  expect(issued).toBe(1);
  expect(result.err).toContain(hostId);
  expect(result.err).toContain("do not issue another registration blindly");
});
