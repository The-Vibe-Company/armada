import { createHash } from "node:crypto";
import type { Sql } from "@armada/core";
import { GoldenError, LaunchError, type Provider } from "@armada/core/server";

interface Scope {
  orgId: string;
  userId: string;
}
interface Receipt {
  id: string;
  fingerprint: string;
  response: unknown;
}

/** Atomic, fail-closed admission. An unfinished receipt is never dispatched again. */
export function createOrdinaryLaunchReceipts(sql: Sql) {
  return {
    async run<T>(actor: Scope, key: string, payload: unknown, dispatch: (id: string) => Promise<T>): Promise<T> {
      const fingerprint = createHash("sha256").update(canonical(payload)).digest("hex");
      const id = crypto.randomUUID();
      const inserted = await sql.query<Receipt>(
        `INSERT INTO public.ordinary_launch_receipts (id, org_id, owner_id, request_key, fingerprint)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id, owner_id, request_key) DO NOTHING RETURNING id`,
        [id, actor.orgId, actor.userId, key, fingerprint],
      );
      if (!inserted.rows.length) {
        const { rows } = await sql.query<Receipt>(
          `SELECT id, fingerprint, response FROM public.ordinary_launch_receipts
           WHERE org_id=$1 AND owner_id=$2 AND request_key=$3`,
          [actor.orgId, actor.userId, key],
        );
        const prior = rows[0];
        if (!prior)
          throw new LaunchError("outcome_unknown", "Launch receipt unavailable; do not retry with a new key.");
        if (prior.fingerprint !== fingerprint)
          throw new GoldenError("conflict", `Launch key conflicts with receipt ${prior.id}.`);
        if (prior.response !== null) return prior.response as T;
        throw new LaunchError(
          "outcome_unknown",
          `Launch outcome unknown; inspect launch receipt ${prior.id}. Do not use a new key.`,
        );
      }
      try {
        const response = await dispatch(id);
        await sql.query(`UPDATE public.ordinary_launch_receipts SET response=$2::jsonb WHERE id=$1`, [
          id,
          JSON.stringify(response),
        ]);
        return response;
      } catch {
        // Includes lost database acknowledgements and provider replies. Never release the key.
        throw new LaunchError(
          "outcome_unknown",
          `Launch outcome unknown; inspect launch receipt ${id}. Do not use a new key.`,
        );
      }
    },
    async inspect(actor: Scope, id: string, provider: Provider) {
      const { rows } = await sql.query<{ id: string; response: unknown }>(
        `SELECT id, response FROM public.ordinary_launch_receipts WHERE id=$1 AND org_id=$2 AND owner_id=$3`,
        [id, actor.orgId, actor.userId],
      );
      if (!rows[0]) throw new GoldenError("not_found", "Launch receipt not found.");
      const allocations = [];
      let cursor: string | undefined;
      do {
        const page = await provider.list({
          labels: { armada: "sandbox", sandbox: id, org: actor.orgId, owner: actor.userId },
          ...(cursor ? { cursor } : {}),
        });
        for (const item of page.items) {
          if (item.labels.sandbox === id && item.labels.org === actor.orgId && item.labels.owner === actor.userId)
            allocations.push({ id: item.id, state: item.state });
        }
        cursor = page.cursor ?? undefined;
      } while (cursor);
      return {
        id,
        response: rows[0].response,
        allocations,
        outcome: rows[0].response === null ? "unknown" : "completed",
      };
    },
  };
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
