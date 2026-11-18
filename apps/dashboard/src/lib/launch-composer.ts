import type { SandboxPlacementProviderId } from "@armada/core";
import { ttlOptions } from "./templates";

export function composerChips(
  provider: SandboxPlacementProviderId,
  folders: number,
  sizing: boolean,
  template = false,
) {
  const cloud = provider !== "docker";
  return { folder: cloud && folders > 0, machine: cloud && sizing, access: cloud && !template, docker: !cloud };
}

export function launchSendLabel(task: string, docker: boolean, template: boolean) {
  return !docker && !template && !task.trim() ? "Launch idle" : "Launch";
}

export function launchHoldIds(
  id: string,
  holds: { source?: boolean; account?: boolean; tools?: boolean; template?: boolean },
) {
  return [
    holds.source && `${id}-source-blocked`,
    holds.account && `${id}-account-unavailable`,
    holds.tools && `${id}-held`,
    holds.template && `${id}-blocked`,
  ].filter((value): value is string => Boolean(value));
}

export function launchAgentSummary(agent: string, model: string, effort: string, account?: string) {
  return [agent, model, effort, account].filter(Boolean).join(" · ");
}

export function launchStopLabel(provider: SandboxPlacementProviderId, ttl: string) {
  const label = ttlOptions(provider).find((option) => option.value === ttl)?.label;
  return `Stops in ${label?.replace(/^Default \((.*)\)$/, "$1") ?? "4 hours"}`;
}

/** The Tools the agent can call a launch gets, as one summary fact. */
export function launchToolsSummary(access: {
  unavailable: boolean;
  selected: number;
  selectedName?: string | undefined;
}): string {
  if (access.unavailable) return "Tools unavailable";
  if (access.selected === 1 && access.selectedName) return `${access.selectedName} connected`;
  return access.selected === 0 ? "No tools" : `${access.selected} ${access.selected === 1 ? "tool" : "tools"}`;
}
