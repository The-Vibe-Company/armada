import type { SandboxStatus } from "@armada/core";
import { filtersToSearch } from "./sandbox-filters";

export const INLINE_LIVE_LIMIT = 5;
export const LIVE_STATUSES: SandboxStatus[] = ["starting", "ready", "running", "stopping"];
export const LIVE_SANDBOXES_HREF = `/sandboxes${filtersToSearch({ status: LIVE_STATUSES })}`;

export type LiveSandbox = { id: string; label: string; status: SandboxStatus };
export type LiveSandboxes = { rows: LiveSandbox[]; total: number };
