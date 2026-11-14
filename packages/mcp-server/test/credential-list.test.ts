import { expect, test } from "bun:test";
import type { VaultStore } from "@armada/core/server";
import { listControlCredentials } from "../src/credential-list.ts";

test("credential metadata overlaps org reads after membership and retains core response filtering", async () => {
  const orgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  const store = {
    memberships: async () => {
      calls.push("memberships");
      return [{ id: orgId, name: "Example", role: "member" }];
    },
    listCredentials: async (scope: string, id: string) => {
      calls.push(`${scope}:${id}`);
      if (scope === "user") return [{ kind: "openai", createdAt: null, status: "deleted" }];
      entered.resolve();
      await release.promise;
      return [{ kind: "anthropic", createdAt: null }];
    },
    hasOrgBoatKey: async (id: string) => {
      calls.push(`key:${id}`);
      await release.promise;
      return true;
    },
  } as unknown as VaultStore;
  const result = listControlCredentials(store, "user_id", orgId);
  await entered.promise;
  const pending = [...calls];
  release.resolve();
  expect(pending).toEqual(["memberships", "user:user_id", `org:${orgId}`, `key:${orgId}`]);
  expect(await result).toEqual({
    user: [],
    orgs: [
      {
        id: orgId,
        name: "Example",
        role: "member",
        credentials: [
          { kind: "boat", createdAt: null },
          { kind: "anthropic", createdAt: null },
        ],
      },
    ],
  });
});

test("parallel key failures are observed without replacing an earlier credential failure", async () => {
  const credentialError = new Error("credential_read_failed");
  const keyError = new Error("key_presence_failed");
  for (const failCredentials of [true, false]) {
    const store = {
      memberships: async () => [{ id: "org_id", name: "Example", role: "member" }],
      listCredentials: async (scope: string) => {
        if (scope === "org" && failCredentials) throw credentialError;
        return [];
      },
      hasOrgBoatKey: async () => {
        throw keyError;
      },
    } as unknown as VaultStore;
    await expect(listControlCredentials(store, "user_id", undefined)).rejects.toBe(
      failCredentials ? credentialError : keyError,
    );
  }
});

test("own metadata starts while membership is pending, but org reads remain behind membership", async () => {
  const entered = Promise.withResolvers<void>();
  const membership = Promise.withResolvers<{ id: string; name: string; role: "member" }[]>();
  const calls: string[] = [];
  const store = {
    memberships: async () => {
      calls.push("memberships");
      entered.resolve();
      return membership.promise;
    },
    listCredentials: async (scope: string, owner: string) => {
      calls.push(`${scope}:${owner}`);
      return [];
    },
    hasOrgBoatKey: async () => false,
  } as unknown as VaultStore;
  const result = listControlCredentials(store, "user_id", undefined);
  await entered.promise;
  const beforeMembership = [...calls];
  membership.resolve([{ id: "org_id", name: "Example", role: "member" }]);
  await result;
  expect(beforeMembership).toEqual(["memberships", "user:user_id"]);
  expect(calls.filter((call) => call.startsWith("org:"))).toEqual(["org:org_id"]);
});

test("membership failure wins over an unused own-metadata failure without starting org reads", async () => {
  const membershipError = new Error("membership_failed");
  const metadataError = new Error("metadata_failed");
  const reads: string[] = [];
  const store = {
    memberships: async () => {
      throw membershipError;
    },
    listCredentials: async (scope: string, owner: string) => {
      reads.push(`${scope}:${owner}`);
      throw metadataError;
    },
    hasOrgBoatKey: async () => {
      throw new Error("must not read an org key");
    },
  } as unknown as VaultStore;
  await expect(listControlCredentials(store, "user_id", undefined)).rejects.toBe(membershipError);
  expect(reads).toEqual(["user:user_id"]);
});
