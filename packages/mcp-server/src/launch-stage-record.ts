import { type LaunchStage, recordLaunchStageSql } from "@armada/core";
import type { Sql } from "@armada/core/server";

/**
 * #2560: persist one launch stage for the sandbox's current activation, inside the caller's transaction when it has
 * one, dated by the database clock. The earliest report of a stage wins.
 */
export async function recordLaunchStage(tx: Pick<Sql, "query">, sandboxId: string, stage: LaunchStage) {
  await recordLaunchStageSql(tx, sandboxId, stage);
}

/** Measurement outside a lifecycle transaction must never change the outcome it measures. */
export async function recordLaunchStageQuietly(sql: Pick<Sql, "query">, sandboxId: string, stage: LaunchStage) {
  try {
    await recordLaunchStageSql(sql, sandboxId, stage);
  } catch {
    try {
      console.error(`armada: launch stage ${stage} unavailable; the launch continues.`);
    } catch {
      /* Logging must not change accepted work. */
    }
  }
}
