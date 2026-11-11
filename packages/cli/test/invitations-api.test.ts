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
  options: {
    response?: unknown;
    status?: number;
    fileError?: boolean;
    orgs?: { id: string; name: string; role: string }[];
    stdin?: string;
  } = {},
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
        preferences: { read: async () => "11111111-1111-4111-8111-111111111111", write: async () => {} },
        fetch: async (input, init) => {
          requests.push(input instanceof Request ? new Request(input, init) : new Request(input.toString(), init));
          if (requests.at(-1)?.url.endsWith("/api/v1/org/list")) return Response.json({ orgs: options.orgs ?? [] });
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
      argv: ["create", invitation.email, "--role", "admin", "--org", "22222222-2222-4222-8222-222222222222"],
      action: "create",
      body: { org: "22222222-2222-4222-8222-222222222222", email: invitation.email, role: "admin" },
      response: { invitation },
      output: { invitation },
    },
    {
      argv: ["create", invitation.email],
      action: "create",
      body: { org: "11111111-1111-4111-8111-111111111111", email: invitation.email, role: "member" },
      response: { invitation },
      output: { invitation },
    },
    {
      argv: ["list"],
      action: "list",
      body: { org: "11111111-1111-4111-8111-111111111111" },
      response: { invitations: [invitation] },
      output: { invitations: [invitation] },
    },
    ...["resend", "revoke"].map((action) => ({
      argv: [action, "invite-1"],
      action,
      body: { org: "11111111-1111-4111-8111-111111111111", id: "invite-1" },
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

test("invitation organization names resolve through authenticated org/list before management", async () => {
  const org = { id: "22222222-2222-4222-8222-222222222222", name: "Team", role: "admin" };
  const result = await invoke(["create", invitation.email, "--org", "team", "--json"], { orgs: [org] });
  expect(result.code).toBe(0);
  expect(result.requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/api/v1/org/list",
    "/api/v1/org/invitations/create",
  ]);
  expect(result.requests[0]?.headers.get("authorization")).toBe("Bearer fixture-armada-bearer");
  expect(await result.requests[0]?.json()).toEqual({});
  expect(await result.requests[1]?.json()).toEqual({ org: org.id, email: invitation.email, role: "member" });
  for (const orgs of [[], [org, { ...org, id: "33333333-3333-4333-8333-333333333333" }]]) {
    const denied = await invoke(["list", "--org", "Team"], { orgs });
    expect(denied.code).toBe(2);
    expect(denied.requests).toHaveLength(1);
    expect(denied.err).toContain("UUID or exact unambiguous name");
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
      response: { error: { code: status === 404 ? "not_found" : "unavailable", message: "fixture-invitation-token" } },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(JSON.parse(result.err).error.message).toContain(meaning);
    expect(result.err).not.toContain("fixture-invitation-token");
  }
});

test("typed invitation reasons select safe actionable text and numeric retry hints", async () => {
  const cases = [
    ["personal_login_required", "Unset ARMADA_TOKEN"],
    ["wrong_email", "recipient's verified email"],
    ["unverified_email", "Verify your account email"],
    ["not_found", "Invitation not found"],
    ["expired", "admin to resend"],
    ["revoked", "new invitation"],
    ["used", "already used"],
    ["already_member", "Existing membership is unchanged"],
    ["pending_exists", "resend or revoke"],
    ["rate_limited", "Retry after 60 seconds"],
    ["invalid", "Invalid invitation request"],
    ["fixture-invitation-token", "conflict or rate limit"],
    ["constructor", "conflict or rate limit"],
  ];
  for (const [reason, expected] of cases) {
    const result = await invoke(["accept", "--json"], {
      status: 409,
      response: { error: { code: "conflict", reason, retryAfterSeconds: 60, message: "fixture-invitation-token" } },
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.err).error.message).toContain(expected);
    expect(result.err).not.toContain("fixture-invitation-token");
  }
  for (const retryAfterSeconds of ["fixture-invitation-token", -1, 1.5, null]) {
    const result = await invoke(["resend", "invite-1"], {
      status: 409,
      response: { error: { reason: "rate_limited", retryAfterSeconds } },
    });
    expect(result.err).toContain("rate limit reached");
    expect(result.err).not.toContain("Retry after");
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
