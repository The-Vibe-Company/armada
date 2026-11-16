import type { GoldenBuildStatus } from "@armada/core";

/** Where a failure can be followed up: a same-origin dashboard path and its link text. */
export type ActionLink = { href: string; label: string };

export type ActionResult =
  | { ok: true; message: string; build?: GoldenBuildStatus }
  | { ok: false; error: string; link?: ActionLink };

export const done = (message: string): ActionResult => ({ ok: true, message });
/** Translate legacy server terminology only at the dashboard presentation boundary. */
export function snapshotText(text: string): string {
  return text.replace(
    /\b(Golden|golden)(s?)\b/g,
    (_, word: string, plural: string) => `${word === "Golden" ? "Snapshot" : "snapshot"}${plural}`,
  );
}

export const fail = (message: string, link?: ActionLink): ActionResult => {
  const error = snapshotText(message);
  return link ? { ok: false, error, link } : { ok: false, error };
};

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
  goldens_org_name_key: "A snapshot with that name is already shared with the org.",
  goldens_private_name_key: "You already have a private snapshot with that name.",
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
    if (error.message === "no account for that email: the person signs in to Armada once first")
      return "No account was found for that email. Ask the person to sign in to Armada once first, then invite them again.";
    if (error.message === "an org keeps at least one admin")
      return "This change would leave the org without an admin. Make another member an admin first.";
    if (error.code === "28000") return "The session was refused. Sign in again before retrying this change.";
    if (error.code === "P0002") return "The requested item was not found. Reload the page and check your selection.";
    return "This change violates a resource rule. Reload the page and check the values before trying again.";
  }
  return "The change could not be saved because the database request failed. Reload the page to check whether it was saved before retrying.";
}
