/**
 * The command menu (⌘K, #757): every page of the signed-in app and the actions people reach for, found by typing.
 * Pure, so the ranking is tested without a browser.
 */
export type Command = {
  id: string;
  label: string;
  /** Where it goes. */
  href: string;
  group: "Go to" | "Actions";
  /** Other words a person might type for it. */
  keywords?: readonly string[];
};

export const COMMANDS: readonly Command[] = [
  {
    id: "launch",
    label: "Launch a sandbox",
    href: "/environments",
    group: "Actions",
    keywords: ["new", "start", "run"],
  },
  {
    id: "add-account",
    label: "Add a subscription",
    href: "/harness",
    group: "Actions",
    keywords: ["claude", "codex", "chatgpt", "account", "api", "key"],
  },
  {
    id: "connect-provider",
    label: "Connect a sandbox provider",
    href: "/settings",
    group: "Actions",
    keywords: ["boat", "modal", "hosting", "key"],
  },
  {
    id: "routines",
    label: "Routines",
    href: "/routines",
    group: "Go to",
    keywords: ["schedule", "interval", "pause", "runs"],
  },
  { id: "sandboxes", label: "Sandboxes", href: "/sandboxes", group: "Go to", keywords: ["agents", "logs", "running"] },
  {
    id: "environments",
    label: "Environments",
    href: "/environments",
    group: "Go to",
    keywords: ["goldens", "snapshots", "repositories"],
  },
  {
    id: "templates",
    label: "Templates",
    href: "/templates",
    group: "Go to",
    keywords: ["presets", "launch", "model", "variables"],
  },
  { id: "tools", label: "Tools", href: "/tools", group: "Go to", keywords: ["mcp", "connections"] },
  { id: "skills", label: "Skills", href: "/skills", group: "Go to", keywords: ["skillpack", "key", "private"] },
  {
    id: "variables",
    label: "Variables",
    href: "/variables",
    group: "Go to",
    keywords: ["secrets", "environment", "env", "config"],
  },
  {
    id: "harness",
    label: "Models",
    href: "/harness",
    group: "Go to",
    keywords: ["subscriptions", "accounts", "claude", "codex", "credentials", "harness"],
  },
  { id: "orgs", label: "Organizations", href: "/orgs", group: "Go to", keywords: ["members", "roles", "team"] },
  { id: "settings", label: "Settings", href: "/settings", group: "Go to", keywords: ["providers", "github"] },
];

/**
 * The commands that match `query`, best first: a label that starts with it, then a word of the label that does, then
 * a keyword that does, then the label containing it anywhere. Ties keep the list's order. An empty query is every
 * command, in order. Matching ignores case and surrounding space.
 */
export function matchCommands(query: string, commands: readonly Command[] = COMMANDS): Command[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...commands];
  const ranked: { command: Command; rank: number; index: number }[] = [];
  commands.forEach((command, index) => {
    const rank = rankOf(command, needle);
    if (rank !== null) ranked.push({ command, rank, index });
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map((item) => item.command);
}

function rankOf(command: Command, needle: string): number | null {
  const label = command.label.toLowerCase();
  if (label.startsWith(needle)) return 0;
  if (label.split(/\s+/).some((word) => word.startsWith(needle))) return 1;
  if (command.keywords?.some((word) => word.startsWith(needle))) return 2;
  if (label.includes(needle)) return 3;
  return null;
}

/** The modifier a shortcut is pressed with on this platform: ⌘ on Apple systems, Ctrl elsewhere. */
export function modifierKey(platform: string): "⌘" | "Ctrl" {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}
