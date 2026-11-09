import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const invitation = {
  id: "invite-1",
  orgId: "org-1",
  email: "recipient@example.invalid",
  role: "admin",
  expiresAt: "2026-12-01T00:00:00Z",
  status: "pending",
  delivery: "sent",
};

async function invoke(
  argv: string[],
  options: { response?: unknown; status?: number; fileError?: boolean; stdin?: string } = {},
) {
  let out = "";
  let err = "";
  const requests: Request[] = [];
  const code = await run(
    ["org", "invitations", ...argv],
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
        out: (text) => {
          out += text;
        },
        err: (text) => {
          err += text;
        },
        env: { ARMADA_TOKEN: "fixture-armada-bearer", ARMADA_URL: "https://armada.example.invalid" },
        session: memorySessionStore(),
        now: () => new Date(),
        open: () => {},
        preferences: { read: async () => "selected-org", write: async () => {} },
        fetch: async (input, init) => {
          requests.push(input instanceof Request ? new Request(input, init) : new Request(input.toString(), init));
          return Response.json(options.response ?? { invitation }, { status: options.status ?? 200 });
        },
      },
      readStdin: async () => options.stdin ?? "  fixture-invitation-token\n",
      readFile: async () => {
        if (options.fileError) throw new Error("fixture-invitation-token");
        return "fixture-file-token\n";
      },
    },
  );
  return { code, out, err, requests };
}

test("invitation commands consume the v1 authenticated POST contract and public output only", async () => {
  const cases = [
    {
      argv: ["create", invitation.email, "--role", "admin", "--org", "explicit-org"],
      action: "create",
      body: { org: "explicit-org", email: invitation.email, role: "admin" },
      response: { invitation },
      output: { invitation },
    },
    {
      argv: ["create", invitation.email],
      action: "create",
      body: { org: "selected-org", email: invitation.email, role: "member" },
      response: { invitation },
      output: { invitation },
    },
    {
      argv: ["list"],
      action: "list",
      body: { org: "selected-org" },
      response: { invitations: [invitation] },
      output: { invitations: [invitation] },
    },
    ...["resend", "revoke"].map((action) => ({
      argv: [action, "invite-1"],
      action,
      body: { org: "selected-org", id: "invite-1" },
      response: { invitation },
      output: { invitation },
    })),
    {
      argv: ["accept"],
      action: "accept",
      body: { token: "fixture-invitation-token" },
      response: { orgId: "org-1", accepted: true },
      output: { orgId: "org-1", accepted: true },
    },
    {
      argv: ["accept", "--file", "input.txt"],
      action: "accept",
      body: { token: "fixture-file-token" },
      response: { orgId: "org-1", accepted: true },
      output: { orgId: "org-1", accepted: true },
    },
  ];
  for (const entry of cases) {
    const result = await invoke([...entry.argv, "--json"], {
      response: {
        ...entry.response,
        token: "not-public",
        ...(entry.action === "accept"
          ? {}
          : entry.action === "list"
            ? { invitations: [{ ...invitation, token: "not-public" }] }
            : { invitation: { ...invitation, token: "not-public" } }),
      },
    });
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out)).toEqual(entry.output);
    expect(result.requests).toHaveLength(1);
    const request = result.requests[0];
    expect(request?.url).toBe(`https://armada.example.invalid/api/v1/org/invitations/${entry.action}`);
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe("Bearer fixture-armada-bearer");
    expect(await request?.json()).toEqual(entry.body);
  }
});

test("invitation output distinguishes provider acceptance from delivery and shows empty lists", async () => {
  expect((await invoke(["create", invitation.email])).out).toContain(
    "email provider accepted; inbox delivery unconfirmed",
  );
  expect((await invoke(["list"], { response: { invitations: [] } })).out).toBe("No invitations.\n");
  for (const delivery of ["not_configured", "pending", "failed"]) {
    const result = await invoke(["resend", "invite-1"], { response: { invitation: { ...invitation, delivery } } });
    expect(result.out).toContain(`email: ${delivery}`);
    expect(result.out).not.toContain("provider accepted");
  }
});

test("invitation API errors remain useful without echoing server text or tokens", async () => {
  for (const [status, meaning] of [
    [400, "Invalid invitation"],
    [401, "verified email"],
    [403, "forbidden"],
    [404, "not found"],
    [409, "conflict or rate limit"],
    [503, "unavailable"],
  ] as const) {
    const result = await invoke(["accept", "--json"], {
      status,
      response: { error: { message: "fixture-invitation-token" } },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(JSON.parse(result.err).error.message).toContain(meaning);
    expect(result.err).not.toContain("fixture-invitation-token");
  }
});

test("unsafe acceptance arguments and input failures never reach the API or echo input", async () => {
  for (const argv of [
    ["accept", "fixture-invitation-token"],
    ["accept", "--fixture-invitation-token"],
    ["accept", "--org", "fixture-invitation-token"],
    ["create", "x", "--role", "fixture-invitation-token"],
  ]) {
    const result = await invoke(argv);
    expect(result.code).toBe(2);
    expect(result.requests).toHaveLength(0);
    expect(result.err).not.toContain("fixture-invitation-token");
  }
  for (const options of [{ fileError: true }, { stdin: "  \n" }]) {
    const result = await invoke(
      options.fileError ? ["accept", "--file", "fixture-invitation-token"] : ["accept"],
      options,
    );
    expect(result.code).toBe(2);
    expect(result.requests).toHaveLength(0);
    expect(result.err).not.toContain("fixture-invitation-token");
  }
});
