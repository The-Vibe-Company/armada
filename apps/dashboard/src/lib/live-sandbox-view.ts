import type { SandboxStatus } from "@armada/core";
import { statusLook } from "./status-tone";

export const INLINE_LIVE_LIMIT = 5;
export const LIVE_STATUSES: SandboxStatus[] = ["starting", "ready", "running", "stopping"];
export const LIVE_SANDBOXES_HREF = "/sandboxes?activity=active";
export const LIVE_FLEET_REFRESH_EVENT = "armada:live-fleet-refresh";
export const LIVE_FLEET_CHANGE_EVENT = "armada:live-fleet-change";

export type LiveSandbox = { id: string; label: string; status: SandboxStatus; working: boolean };
export type LiveSandboxes = { rows: LiveSandbox[]; total: number };

export function liveSandboxesFingerprint(live: LiveSandboxes | null | undefined) {
  if (!live) return "";
  return `${live.total}|${live.rows.map((row) => `${row.id}:${row.status}:${row.working ? 1 : 0}:${row.label}`).join(",")}`;
}

export function liveSandboxLook(sandbox: Pick<LiveSandbox, "status" | "working">) {
  if (sandbox.working) return statusLook("running");
  if (sandbox.status === "running") return { tone: "neutral" as const, pulse: false, label: "Running" };
  return statusLook(sandbox.status);
}
