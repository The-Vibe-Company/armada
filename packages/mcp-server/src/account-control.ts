import { VERSION } from "@armada/core";
import { accountOperations, controlRouteKey } from "@armada/core/contract";
import { VaultError } from "@armada/core/server";
import type { z } from "zod";
import { defineRoutes } from "./routes.ts";

const { readAccountStatus: status, logoutAccount: logout } = accountOperations;

export const accountRoutes = defineRoutes("account-control", {
  [controlRouteKey(status.route)]: {
    methods: [status.route.method],
    handler: ({ caller }) =>
      ({
        userId: caller.userId,
        orgs: caller.orgs,
        authentication: caller.via,
        version: VERSION,
      }) satisfies z.output<typeof status.output>,
  },
  [controlRouteKey(logout.route)]: {
    methods: [logout.route.method],
    handler: async ({ caller, options, request }) => {
      if (!request) return undefined;
      if (caller.via !== "supabase")
        throw new VaultError("forbidden", "Use a personal login session to sign out remotely.");
      const response = await (options.supabase.fetch ?? fetch)(
        new URL("/auth/v1/logout?scope=local", options.supabase.supabaseUrl),
        {
          method: "POST",
          headers: { apikey: options.supabase.anonKey, authorization: request.headers.get("authorization") ?? "" },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new VaultError("unavailable", "The account session could not be signed out.");
      return { ok: true } satisfies z.output<typeof logout.output>;
    },
  },
});
