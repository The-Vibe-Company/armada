import { launchBlocker, type McpConnection } from "./connections";

export function launchToolGroups(tools: readonly McpConnection[], chosen: readonly string[]) {
  const groups = [
    { title: "Needs attention", ids: [] as string[] },
    { title: "On for this launch", ids: [] as string[] },
    { title: "Available", ids: [] as string[] },
  ] as const;
  for (const tool of tools) {
    const group = launchBlocker(tool) ? groups[0] : chosen.includes(tool.id) ? groups[1] : groups[2];
    group.ids.push(tool.id);
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
