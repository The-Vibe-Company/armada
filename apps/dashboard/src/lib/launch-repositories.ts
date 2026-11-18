import { repositoryIdentity } from "@armada/core";
import type { LaunchStartTarget } from "./launch-picker";
import type { TemplateLaunchTarget } from "./template-launch";

export function launchRepositoryChoices(starts: readonly LaunchStartTarget[]) {
  const choices = new Map<string, number>();
  for (const start of starts) {
    const repositories = new Set(start.repositories.map(({ url }) => repositoryIdentity(url)));
    for (const repository of repositories) {
      if (repository) choices.set(repository, (choices.get(repository) ?? 0) + (start.reason ? 0 : 1));
    }
  }
  return [...choices].sort(([left], [right]) => left.localeCompare(right));
}

export function launchRepositoryInput(query: string) {
  const value = query.trim();
  return /^[\w.-]+\/[\w.-]+$/.test(value) ? repositoryIdentity(`https://github.com/${value}`) : null;
}

export function launchRepositoryFolder(start: LaunchStartTarget, repository: string) {
  return start.repositories.find(({ url }) => repositoryIdentity(url) === repository)?.dir;
}

export function launchRepositoryStarts(starts: readonly LaunchStartTarget[], repository: string) {
  if (!repository) return { matches: starts, others: [], preferred: undefined };
  const matches = starts
    .filter((start) => launchRepositoryFolder(start, repository) !== undefined)
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  const others = starts.filter((start) => !matches.includes(start));
  return { matches, others, preferred: matches.find((start) => !start.reason) ?? matches[0] };
}

export function launchRepositoryTemplates(
  templates: readonly TemplateLaunchTarget[],
  starts: readonly LaunchStartTarget[],
  repository: string,
  selected: LaunchStartTarget,
) {
  return templates.filter(({ definition }) => {
    const matches = (start: LaunchStartTarget) =>
      start.provider === definition.provider &&
      (definition.provider === "docker"
        ? definition.snapshotId
          ? start.snapshotId === definition.snapshotId
          : start.hostId === definition.hostId
        : (start.sourceId ?? start.id) === definition.goldenId);
    return repository
      ? starts.some((start) => matches(start) && launchRepositoryFolder(start, repository) !== undefined)
      : matches(selected);
  });
}
