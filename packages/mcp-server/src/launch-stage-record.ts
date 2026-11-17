import { type LaunchStage, type Provider, recordFirstTokenSql, recordLaunchStageSql } from "@armada/core";
import type { Sql } from "@armada/core/server";

/**
 * #2560: persist one launch stage for the sandbox's current activation, inside the caller's transaction when it has
 * one, dated by the database clock. The earliest report of a stage wins.
 */
export async function recordLaunchStage(tx: Pick<Sql, "query">, sandboxId: string, stage: LaunchStage) {
  await recordLaunchStageSql(tx, sandboxId, stage);
}

/**
 * #2560: persist a stage observed by a job that belongs to one known activation, not to whichever activation is
 * current. A replayed or late observation from an earlier activation therefore lands on that activation (earliest
 * wins) and never dates a later resume. Nothing is written when the activation was never opened.
 */
export async function recordLaunchStageForActivation(
  tx: Pick<Sql, "query">,
  sandboxId: string,
  activation: number,
  stage: LaunchStage,
) {
  await tx.query(
    `insert into public.sandbox_launch_stages(sandbox_id,activation,stage,at)
     select a.sandbox_id,a.activation,$3,clock_timestamp() from public.sandbox_launch_stages a
      where a.sandbox_id=$1::uuid and a.activation=$2 and a.stage='accepted'
     on conflict(sandbox_id,activation,stage) do update set at=least(sandbox_launch_stages.at,excluded.at)`,
    [sandboxId, activation, stage],
  );
}

/** Measurement outside a lifecycle transaction must never change the outcome it measures. */
export async function recordLaunchStageQuietly(sql: Pick<Sql, "query">, sandboxId: string, stage: LaunchStage) {
  try {
    await recordLaunchStageSql(sql, sandboxId, stage);
  } catch {
    quietFailure(stage);
  }
}

function quietFailure(stage: LaunchStage) {
  try {
    console.error(`armada: launch stage ${stage} unavailable; the launch continues.`);
  } catch {
    /* Logging must not change accepted work. */
  }
}

/**
 * #2560: native Boat/Modal model output never reaches the runtime upload path; the server sees it only when it reads
 * the provider's events. Record first_token for Armada sandbox `sandboxId` from every page read, dated by the event's
 * own time. The page returned to the caller is unchanged, and a failed record never fails the read.
 */
export function observeNativeFirstToken(provider: Provider, sandboxId: string, sql: Pick<Sql, "query">): Provider {
  return new Proxy(provider, {
    get(instance, property, receiver) {
      const value = Reflect.get(instance, property, receiver);
      if (typeof value !== "function") return value;
      if (property !== "events") return value.bind(instance);
      return async (...args: Parameters<Provider["events"]>) => {
        const page = await (value as Provider["events"]).apply(instance, args);
        try {
          await recordFirstTokenSql(sql, sandboxId, page.events);
        } catch {
          quietFailure("first_token");
        }
        return page;
      };
    },
  });
}
