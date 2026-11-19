import { isSandboxProvider, SANDBOX_PLACEMENT_LABELS, type SandboxPlacementProviderId } from "@armada/core";
import type { LaunchStartTarget } from "./launch-picker";
import { type TemplateLaunchTarget, templatePlacementId } from "./template-launch";
import { ttlOptions } from "./templates";

export function composerChips(
  provider: SandboxPlacementProviderId,
  folders: number,
  sizing: boolean,
  template = false,
) {
  const cloud = isSandboxProvider(provider);
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

export function launchToolsSummary(access: {
  unavailable: boolean;
  selected: number;
  selectedName?: string | undefined;
}) {
  if (access.unavailable) return "Tools unavailable";
  if (access.selected === 1 && access.selectedName) return `${access.selectedName} connected`;
  return access.selected === 0 ? "No tools" : `${access.selected} ${access.selected === 1 ? "tool" : "tools"}`;
}

export const MISSING_LAUNCH_START = "This starting point is no longer available. Pick another snapshot or Docker host.";

export function templateStartAfterRemoval(template: TemplateLaunchTarget, starts: readonly LaunchStartTarget[]) {
  const { definition } = template;
  const docker = "hostId" in definition;
  const id = templatePlacementId(definition);
  const current = starts.find((start) => start.id === id);
  if (current) return current;

  const group = docker ? "Docker hosts" : `${SANDBOX_PLACEMENT_LABELS[definition.provider]} cloud`;
  return {
    id,
    golden: template.goldenName?.replace(/ · (Boat|Modal) cloud$/, "") ?? "Unavailable snapshot",
    label: template.goldenName ?? "Unavailable snapshot",
    group,
    provider: definition.provider,
    reason: MISSING_LAUNCH_START,
    repositories: [],
    ...(template.sizing ? { sizing: template.sizing } : {}),
    ...(template.hostName ? { hostName: template.hostName } : {}),
    ...(docker && definition.snapshotId ? { snapshotId: definition.snapshotId } : {}),
    ...(docker && !definition.snapshotId && definition.hostId ? { hostId: definition.hostId } : {}),
  } satisfies LaunchStartTarget;
}

export function prioritizeRepositoryHold(repositoryHold: string | undefined, holds: readonly string[]) {
  return repositoryHold ? [repositoryHold, ...holds] : holds;
}
