import { expect, test } from "bun:test";
import type { GoldenRecord } from "@armada/core/server";
import type { Caller } from "../src/caller.ts";
import { listGoldens } from "../src/golden-control.ts";

test("golden listing starts org reads together without changing caller scope", async () => {
  const caller: Caller = {
    userId: "user_id",
    via: "supabase",
    orgs: [
      { orgId: "first_org", role: "admin" },
      { orgId: "second_org", role: "member" },
    ],
  };
  const started: string[] = [];
  const release: (() => void)[] = [];
  const result = listGoldens(
    {
      data: (scoped: Caller) => {
        expect(scoped).toBe(caller);
        return {
          goldens: {
            list: (orgId: string) => {
              started.push(orgId);
              const row: GoldenRecord = {
                id: orgId,
                orgId,
                name: orgId,
                ownerId: caller.userId,
                visibility: "org",
                provider: "boat",
                providerSnapshotId: null,
                providerSandboxId: null,
                modal: null,
                config: { repos: [], init: [] },
                createdAt: "2026-11-14T00:00:00Z",
              };
              return new Promise<GoldenRecord[]>((resolve) => release.push(() => resolve([row])));
            },
          },
        };
      },
    } as unknown as Parameters<typeof listGoldens>[0],
    caller,
  );
  const concurrent = [...started];
  // Release before asserting so a pre-fix failure never leaves a pending query.
  for (const done of release.reverse()) done();
  expect(concurrent).toEqual(["first_org", "second_org"]);
  expect((await result).goldens.map((row) => row.orgId)).toEqual(["first_org", "second_org"]);
});
