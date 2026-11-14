import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createOttoRuntime } from "../src/otto/runtime.ts";

test("Otto retains independent explicit repository bindings and rejects ambiguous configuration", () => {
  const sql = {
    async query() {
      throw Error("No I/O at setup");
    },
  };
  const orgId = "00000000-0000-0000-0000-000000000001";
  expect(createOttoRuntime(sql, {})).toBeUndefined();
  expect(createOttoRuntime(sql, { ARMADA_OTTO_ORG_ID: orgId, ARMADA_OTTO_REPOSITORY: "example/web" })?.scopes).toEqual([
    { orgId, repository: "example/web" },
  ]);
  expect(
    createOttoRuntime(sql, { ARMADA_OTTO_ORG_ID: orgId, ARMADA_OTTO_REPOSITORIES: "example/web,example/skills" })
      ?.scopes,
  ).toEqual([
    { orgId, repository: "example/web" },
    { orgId, repository: "example/skills" },
  ]);
  for (const repositories of ["example/web,EXAMPLE/web", "example/web,", "not-a-repository"])
    expect(() =>
      createOttoRuntime(sql, { ARMADA_OTTO_ORG_ID: orgId, ARMADA_OTTO_REPOSITORIES: repositories }),
    ).toThrow();
});

test("webhook authentication precedes JSON parsing and repository routing", async () => {
  const runtime = createOttoRuntime(
    {
      async query() {
        throw Error("No observation expected");
      },
    },
    {
      ARMADA_OTTO_ORG_ID: "00000000-0000-0000-0000-000000000001",
      ARMADA_OTTO_REPOSITORIES: "example/web,example/skills",
      ARMADA_OTTO_WEBHOOK_SECRET: "webhook_fixture",
    },
  )!;
  const send = (body: string, signed: boolean) =>
    runtime.route(
      new Request("https://armada.example/api/v1/otto/github/webhook", {
        method: "POST",
        body,
        headers: {
          "x-hub-signature-256": `sha256=${signed ? createHmac("sha256", "webhook_fixture").update(body).digest("hex") : "0".repeat(64)}`,
          "x-github-delivery": "delivery-fixture",
        },
      }),
    );
  for (const body of [
    "invalid json",
    JSON.stringify({ repository: { full_name: "example/web" } }),
    JSON.stringify({ repository: { full_name: "example/hidden" } }),
  ])
    expect((await send(body, false))?.status).toBe(401);
  expect((await send("invalid json", true))?.status).toBe(400);
  expect((await send(JSON.stringify({ repository: { full_name: "example/hidden" } }), true))?.status).toBe(403);
  expect((await send(JSON.stringify({ repository: { full_name: "example/web" } }), true))?.status).toBe(202);
});
