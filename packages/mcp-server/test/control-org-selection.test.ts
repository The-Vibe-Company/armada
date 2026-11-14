import { expect, test } from "bun:test";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";

test("list org selection reuses authenticated UUID membership but resolves names freshly", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const orgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const anotherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let membershipReads = 0;
  let resolutionReads = 0;
  const listed: string[] = [];
  const options = {
    authStore: {
      memberships: async () => {
        membershipReads++;
        return [
          { orgId, name: "Example", role: "admin" },
          { orgId: anotherId, name: "Other", role: "member" },
        ];
      },
    },
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      anonKey: "public_placeholder",
      fetch: async () => Response.json({ id: userId }),
    },
    store: {
      memberships: async () => {
        resolutionReads++;
        return [{ id: orgId, name: "Example", role: "admin" }];
      },
    },
    data: () => ({
      goldens: {
        list: async (id: string) => {
          listed.push(id);
          return [];
        },
      },
    }),
  } as unknown as ControlOptions;
  for (const org of [` ${orgId.toUpperCase()} `, "Example"]) {
    const response = await handleControlRequest(
      new Request("https://armada.test/api/v1/golden/list", {
        method: "POST",
        headers: { authorization: "Bearer header.payload.signature", "content-type": "application/json" },
        body: JSON.stringify({ org }),
      }),
      options,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ goldens: [] });
    expect(resolutionReads).toBe(org === "Example" ? 1 : 0);
  }
  expect(membershipReads).toBe(2); // Never reuse authentication across requests.
  expect(listed).toEqual([orgId, orgId]);
});
