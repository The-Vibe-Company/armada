import { CREDENTIAL_KINDS, type CredentialKind, type Harness, type SandboxStatus } from "@armada/core";

/**
 * Recovery of a legacy Modal sandbox launched before model accounts were pinned (#603): its owner chooses, once,
 * the named account its turns run on (`sandbox/bind-credential`). The Armada server decides everything (owner,
 * membership, compatible and authorized account, safely stopped, still unbound); the dashboard only offers the
 * choice and never picks one itself.
 */

/** The account kinds each harness runs on, as the server's resolver reads them. Only the offer depends on it. */
export const HARNESS_ACCOUNT_KINDS: Readonly<Record<Harness, readonly CredentialKind[]>> = {
  claude: ["claude_oauth", "anthropic"],
  codex: ["openai", "codex_auth"],
};

/** One account the owner may choose: safe metadata only, never a value. */
export type AccountOption = {
  id: string;
  name: string;
  kind: CredentialKind;
  kindLabel: string;
  scope: "user" | "org";
  isDefault: boolean;
};

/** What the page needs to know about the sandbox. `credential_id` is absent before the #603 migration. */
export type RecoverySandbox = {
  provider: string;
  owner_id: string;
  status: SandboxStatus;
  credential_id?: string | null;
};

/**
 * A Modal sandbox recorded with no pinned account (`credential_id` null): its turns cannot run until its owner binds
 * one. Boat is never concerned, and a row read without the column (a database before #603) is not either.
 */
export function needsAccountChoice(sandbox: RecoverySandbox): boolean {
  return sandbox.provider === "modal" && sandbox.credential_id === null && sandbox.status !== "deleted";
}

/**
 * The server binds only a sandbox that is safely stopped; a live one is stopped first, with the usual Stop. A failed
 * one cannot be stopped and is never bound, so it is not offered a choice at all.
 */
export function bindableStatus(status: SandboxStatus): "ready" | "stop-first" | "wait" | "failed" {
  if (status === "stopped") return "ready";
  if (status === "stopping") return "wait";
  if (status === "failed") return "failed";
  return "stop-first";
}

/**
 * The compatible accounts of a `creds/list` answer (`{user, orgs}`): personal ones, then the sandbox org's, each
 * active, unexpired and of a kind the harness runs on. Rows without an id predate named accounts and are left out.
 */
export function compatibleAccounts(list: unknown, harness: Harness, orgId: string, now: Date): AccountOption[] {
  const kinds = HARNESS_ACCOUNT_KINDS[harness];
  const record = isRecord(list) ? list : {};
  const org = (Array.isArray(record.orgs) ? record.orgs : []).find((item) => isRecord(item) && item.id === orgId);
  const pick = (rows: unknown, scope: "user" | "org"): AccountOption[] =>
    (Array.isArray(rows) ? rows : []).flatMap((row): AccountOption[] => {
      if (!isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string") return [];
      const kind = kinds.find((candidate) => candidate === row.kind);
      if (!kind) return [];
      if (row.status !== undefined && row.status !== "active") return [];
      if (typeof row.expiresAt === "string" && Date.parse(row.expiresAt) <= now.getTime()) return [];
      return [
        {
          id: row.id,
          name: row.name,
          kind,
          kindLabel: CREDENTIAL_KINDS[kind].label,
          scope,
          isDefault: row.isDefault === true,
        },
      ];
    });
  return [...pick(record.user, "user"), ...pick(isRecord(org) ? org.credentials : [], "org")];
}

/** A refused bind, in plain words, by the typed failure the server answers with. */
export function bindFailure(code: string | undefined, message: string): string {
  switch (code) {
    case "credential_binding_unsafe":
      return "The sandbox is not safely stopped yet. Stop it, wait until it shows stopped, then try again.";
    case "conflict":
      return "This sandbox already has an account, or that account just changed. Reload to see it.";
    case "forbidden":
    case "not_found":
      return "Only the sandbox's owner, still a member of its org, can choose its account.";
    default:
      return message;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
