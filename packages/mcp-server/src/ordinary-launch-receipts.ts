import { createHash } from "node:crypto";
import type { ProviderTarget, Sql } from "@armada/core";
import { GoldenError, isNonMutatingProviderRefusal, LaunchError, ProviderError, VaultError } from "@armada/core/server";

const SHARED_KEY_CONFLICT_SQLSTATE = "A2760";

interface Scope {
  orgId: string;
  userId: string;
}
export type OrdinaryLaunchFailure =
  | { kind: "launch"; code: LaunchError["code"]; sandboxId?: string }
  | { kind: "golden"; code: GoldenError["code"] }
  | { kind: "vault"; code: VaultError["code"]; message: string }
  | {
      kind: "provider";
      code: ProviderError["code"];
      provider: string;
      status?: number;
      retryable: boolean;
      retryAfterSeconds?: number;
    };

interface Receipt {
  id: string;
  fingerprint: string;
  response: unknown;
  failure: OrdinaryLaunchFailure | null;
}

/** Atomic, fail-closed admission. An unfinished receipt is never dispatched again. */
export function createOrdinaryLaunchReceipts(sql: Sql) {
  return {
    async run<T>(
      actor: Scope,
      key: string,
      payload: unknown,
      dispatch: (id: string) => Promise<T>,
      authority: { target: ProviderTarget; backendId: string; management: { scope: "org" | "user"; ownerId: string } },
    ): Promise<T> {
      const fingerprint = ordinaryLaunchFingerprint(payload);
      const id = crypto.randomUUID();
      let inserted: { rows: Receipt[] };
      try {
        inserted = await sql.query<Receipt>(
          `INSERT INTO public.ordinary_launch_receipts (id, org_id, owner_id, request_key, fingerprint, authority)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (org_id, owner_id, request_key) DO NOTHING RETURNING id`,
          [id, actor.orgId, actor.userId, key, fingerprint, JSON.stringify(authority)],
        );
      } catch (error) {
        if (
          error instanceof Error &&
          (("errno" in error && error.errno === SHARED_KEY_CONFLICT_SQLSTATE) ||
            ("code" in error && error.code === SHARED_KEY_CONFLICT_SQLSTATE))
        )
          throw new GoldenError("conflict", "Launch key conflicts with an existing receipt.");
        throw error;
      }
      if (!inserted.rows.length) {
        const { rows } = await sql.query<Receipt>(
          `SELECT id, fingerprint, response, failure FROM public.ordinary_launch_receipts
           WHERE org_id=$1 AND owner_id=$2 AND request_key=$3`,
          [actor.orgId, actor.userId, key],
        );
        const prior = rows[0];
        if (!prior)
          throw new LaunchError("outcome_unknown", "Launch receipt unavailable; do not retry with a new key.");
        if (prior.fingerprint !== fingerprint)
          throw new GoldenError("conflict", `Launch key conflicts with receipt ${prior.id}.`);
        if (prior.failure) throw replayOrdinaryLaunchFailure(prior.failure);
        if (prior.response !== null) return prior.response as T;
        throw new LaunchError("outcome_unknown", `Launch outcome unknown; receipt ${prior.id}. Do not use a new key.`);
      }
      try {
        const response = await dispatch(id);
        await sql.query(`UPDATE public.ordinary_launch_receipts SET response=$2::jsonb WHERE id=$1`, [
          id,
          JSON.stringify(response),
        ]);
        return response;
      } catch (error) {
        const failure = terminalFailure(error);
        if (failure) {
          try {
            await sql.query(`UPDATE public.ordinary_launch_receipts SET failure=$2::jsonb WHERE id=$1`, [
              id,
              JSON.stringify(failure),
            ]);
          } catch {
            throw new LaunchError(
              "outcome_unknown",
              `Launch failure could not be recorded; receipt ${id}. Do not use a new key.`,
            );
          }
          throw error;
        }
        // Includes lost database acknowledgements and provider replies. Never release the key.
        throw new LaunchError("outcome_unknown", `Launch outcome unknown; receipt ${id}. Do not use a new key.`);
      }
    },
  };
}

/** Preserve the original request encoding for replay across launch producers. */
export function ordinaryLaunchFingerprint(payload: unknown): string {
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

// Persist only typed public fields, never causes, provider details or raw command output.
function terminalFailure(error: unknown): OrdinaryLaunchFailure | null {
  if (error instanceof VaultError) return { kind: "vault", code: error.code, message: error.message };
  if (error instanceof GoldenError) return { kind: "golden", code: error.code };
  if (
    error instanceof LaunchError &&
    !error.sandboxId &&
    ["invalid_request", "unsupported", "no_credentials"].includes(error.code)
  )
    return { kind: "launch", code: error.code, ...(error.sandboxId ? { sandboxId: error.sandboxId } : {}) };
  if (error instanceof ProviderError && isNonMutatingProviderRefusal(error))
    return {
      kind: "provider",
      code: error.code,
      provider: error.provider,
      ...(error.status === undefined ? {} : { status: error.status }),
      retryable: error.retryable,
      ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  return null;
}

export function replayOrdinaryLaunchFailure(failure: OrdinaryLaunchFailure): Error {
  const message = `Launch refused (${failure.code}). This key records a terminal failure; correct the configuration before submitting a new launch key.`;
  switch (failure.kind) {
    case "vault":
      return new VaultError(failure.code, failure.message);
    case "golden":
      return new GoldenError(failure.code, message);
    case "launch":
      return new LaunchError(failure.code, message, failure.sandboxId ? { sandboxId: failure.sandboxId } : undefined);
    case "provider":
      return new ProviderError({ ...failure, message });
  }
}
