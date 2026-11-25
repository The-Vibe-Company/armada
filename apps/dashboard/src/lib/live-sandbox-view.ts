import type { SandboxStatus } from "@armada/core";
import { filtersToSearch } from "./sandbox-filters";
import { statusLook } from "./status-tone";

export const INLINE_LIVE_LIMIT = 5;
export const LIVE_STATUSES: SandboxStatus[] = ["starting", "ready", "running", "stopping"];
export const LIVE_SANDBOXES_HREF = `/sandboxes${filtersToSearch({ status: LIVE_STATUSES })}`;
export const LIVE_FLEET_REFRESH_EVENT = "armada:live-fleet-refresh";

export type LiveSandbox = { id: string; label: string; status: SandboxStatus; working: boolean };
export type LiveSandboxes = { rows: LiveSandbox[]; total: number };

export function liveSandboxLook(sandbox: Pick<LiveSandbox, "status" | "working">) {
  if (sandbox.working) return statusLook("running");
  if (sandbox.status === "running") return { tone: "neutral" as const, pulse: false, label: "Running" };
  return statusLook(sandbox.status);
}
