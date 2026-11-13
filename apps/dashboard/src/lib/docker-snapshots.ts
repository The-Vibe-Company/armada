import type { DockerSnapshotRecord } from "@armada/core";
import type { ResourceState } from "./resource-list";

/** A saved artifact remains visible when its installation is offline, but cannot start new work. */
export function snapshotState(
  row: Pick<DockerSnapshotRecord, "status" | "hostAvailable">,
  launchEnabled: boolean,
): ResourceState {
  if (row.status === "building") return { bucket: "rest", tone: "info", label: "Building" };
  if (row.status === "failed") return { bucket: "action", tone: "destructive", label: "Build failed" };
  if (!row.hostAvailable) return { bucket: "rest", tone: "warning", label: "Host unavailable" };
  if (!launchEnabled) return { bucket: "rest", tone: "neutral", label: "Launch unavailable" };
  return { bucket: "ready", tone: "success", label: "Ready" };
}

/** Owned-host-only organizations already have a provider: do not send them to cloud onboarding. */
export function hasDockerHost(hosts: readonly { state: string }[]): boolean {
  return hosts.some((host) => host.state !== "revoked");
}
