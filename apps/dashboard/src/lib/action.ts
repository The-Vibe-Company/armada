import type { GoldenBuildStatus } from "@armada/core";

export type ActionResult = { ok: true; message: string; build?: GoldenBuildStatus } | { ok: false; error: string };

export const done = (message: string): ActionResult => ({ ok: true, message });
export const fail = (error: string): ActionResult => ({ ok: false, error });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function formString(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

type DbError = { code?: string | undefined; message: string };

const FRIENDLY: Record<string, string> = {
  members_pkey: "They are already a member of this org.",
  goldens_org_name_key: "A golden with that name is already shared with the org.",
  goldens_private_name_key: "You already have a private golden with that name.",
};

/** A message for the person, from a Postgres or PostgREST error. Row level security denials are one sentence. */
export function explainDbError(error: DbError): string {
  if (error.code === "42501" || /row-level security|permission denied/i.test(error.message)) {
    return "You are not allowed to do that.";
  }
  if (error.code === "23505") {
    for (const [constraint, text] of Object.entries(FRIENDLY)) {
      if (error.message.includes(constraint)) return text;
    }
    return "That already exists.";
  }
  if (error.code === "23514" && /orgs_name_chk|goldens_name_chk/.test(error.message)) {
    return "The name must be between 1 and 120 characters.";
  }
  if (error.code === "23514" || error.code === "P0002" || error.code === "28000") {
    return error.message;
  }
  return "Something went wrong. Try again.";
}
