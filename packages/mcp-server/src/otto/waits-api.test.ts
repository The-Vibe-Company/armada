import { expect, test } from "bun:test";
import { createOttoWaitsApi } from "./waits-api.ts";

test("Your turn refuses non-session callers before storage", async () => {
  const route = createOttoWaitsApi(
    {
      query: async () => {
        throw Error("must not query");
      },
    },
    async () => ({ ok: false }),
  );
  const response = await route(new Request("https://armada.test/api/v1/otto/waits"));
  expect(response?.status).toBe(401);
});

// These principals are authenticated but cannot use the owner-session answer surface.
for (const via of ["service", "mcp"] as const) {
  test(`Your turn rejects authenticated ${via} tokens before storage`, async () => {
    let queries = 0;
    const route = createOttoWaitsApi(
      {
        query: async () => {
          queries++;
          throw Error("must not query");
        },
      },
      async () => ({
        ok: true,
        caller: {
          userId: "22222222-2222-4222-8222-222222222222",
          orgs: [{ orgId: "11111111-1111-4111-8111-111111111111", role: "admin" }],
          via,
        },
      }),
    );
    const response = await route(
      new Request("https://armada.test/api/v1/otto/waits?org_id=11111111-1111-4111-8111-111111111111"),
    );
    expect(response?.status).toBe(403);
    expect(queries).toBe(0);
  });
}
