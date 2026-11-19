import { launchBlocker, type McpConnection } from "./connections";

export function rememberLaunchToolSelection(
  initialSelection: ReadonlyMap<string, boolean>,
  tools: readonly McpConnection[],
  chosen: readonly string[],
) {
  const newTools = tools.filter(({ id }) => !initialSelection.has(id));
  if (newTools.length === 0) return initialSelection;
  return new Map([...initialSelection, ...newTools.map(({ id }) => [id, chosen.includes(id)] as const)]);
}

export function launchToolGroups(tools: readonly McpConnection[], selectionOnOpen: ReadonlyMap<string, boolean>) {
  const groups = [
    { title: "Needs attention", tools: [] as McpConnection[] },
    { title: "On for this launch", tools: [] as McpConnection[] },
    { title: "Available", tools: [] as McpConnection[] },
  ] as const;
  for (const tool of tools) {
    const initiallyChosen = selectionOnOpen.get(tool.id);
    const group = launchBlocker(tool) ? groups[0] : initiallyChosen ? groups[1] : groups[2];
    group.tools.push(tool);
  }
  return groups;
}

export function toolInitials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1))
    .join("")
    .toUpperCase();
}
