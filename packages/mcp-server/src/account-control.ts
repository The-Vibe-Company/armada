import { VERSION } from "@armada/core";
import { VaultError } from "@armada/core/server";
import { defineRoutes } from "./routes.ts";

export const accountRoutes = defineRoutes("account-control", {
  "account/status": ({ caller }) => ({
    userId: caller.userId,
    orgs: caller.orgs,
    authentication: caller.via,
    version: VERSION,
  }),
  "account/logout": async ({ caller, options, request }) => {
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
    return { ok: true };
  },
});
