import type { AuthStore } from "@armada/auth";
import { VaultError } from "@armada/core/server";
import { authenticateCaller, type Caller, type SupabaseProject } from "./caller.ts";

interface CallerControlOptions {
  authStore: AuthStore;
  supabase: SupabaseProject;
  now?: () => Date;
}

export class Unauthorized extends Error {}

/** Shared MCP/control bearer boundary. Callers receive only the orgs embedded in the verified principal. */
export async function authenticatedControlCaller(
  request: Request,
  options: CallerControlOptions,
): Promise<Caller | null> {
  const result = await authenticateCaller(request.headers.get("authorization"), {
    store: options.authStore,
    supabase: options.supabase,
    now: (options.now ?? (() => new Date()))(),
  });
  return result.ok ? result.caller : null;
}

export async function authenticatedCaller(request: Request, options: CallerControlOptions): Promise<Caller> {
  const caller = await authenticatedControlCaller(request, options);
  if (!caller) throw new Unauthorized("Run armada login.");
  return caller;
}

/** A service/OAuth token has exactly one org; never widen that scope from database memberships. */
export function scopedOrg(caller: Caller, requested: string | undefined): string | undefined {
  if (caller.via === "supabase") return requested;
  const orgId = caller.orgs[0]?.orgId;
  if (!orgId) throw new Unauthorized("Run armada login.");
  if (requested !== undefined && requested.trim() !== "" && requested.trim().toLowerCase() !== orgId) {
    throw new VaultError("forbidden", "This token is scoped to another org.");
  }
  return orgId;
}
