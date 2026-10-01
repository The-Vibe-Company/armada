import { ArmadaApiError } from "./armada-api.ts";
import type { HeartbeatRecord, HeartbeatResult } from "./live.ts";

export async function heartbeatLoop(options: {
  ticket: string;
  handle: string;
  everyMs: number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  parentAlive: () => boolean;
  ping: (input: HeartbeatRecord) => Promise<HeartbeatResult>;
  ready?: (result: HeartbeatResult) => Promise<boolean>;
}): Promise<"parent-exited" | "session-ended" | "already-running"> {
  let claimedAt: string | null = null;
  let next = options.now().getTime();
  while (options.parentAlive()) {
    const remaining = next - options.now().getTime();
    if (remaining > 0) {
      await options.sleep(Math.min(1000, remaining));
      continue;
    }
    let result: HeartbeatResult | null = null;
    try {
      result = await options.ping({ ticket: options.ticket, handle: options.handle, claimedAt });
    } catch (error) {
      if (
        error instanceof ArmadaApiError &&
        error.status !== null &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429
      )
        return "session-ended";
    }
    if (result) {
      if (!result.active || !result.claimedAt) return "session-ended";
      if (!claimedAt && options.ready && !(await options.ready(result))) return "already-running";
      claimedAt = result.claimedAt;
    }
    next = options.now().getTime() + options.everyMs;
  }
  return "parent-exited";
}
