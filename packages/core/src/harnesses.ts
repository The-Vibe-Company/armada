import type { CredentialKind } from "./database.types.ts";
import type { HarnessCapabilities } from "./provider.ts";

/** Browser-safe harness metadata. Driver implementations and SQL enums remain at their native boundaries. */
interface HarnessDescriptor {
  credentialKinds: readonly CredentialKind[];
  label: string;
  boatProvider: string | null;
  skillpackTool: string;
  capabilities: HarnessCapabilities;
}

const COMMON_CAPABILITIES = {
  interrupt: true,
  resume: true,
  parallelConversations: true,
  reasoningEffort: true,
  fast: true,
  streamsPartials: true,
  toolEvents: true,
  approvals: false,
} as const;

export const HARNESS_CATALOG = {
  claude: {
    label: "Claude Code",
    skillpackTool: "claude-code",
    credentialKinds: ["claude_oauth", "anthropic", "morph"],
    boatProvider: "claude-code",
    capabilities: { ...COMMON_CAPABILITIES, steer: "native" },
  },
  codex: {
    label: "Codex",
    skillpackTool: "codex",
    credentialKinds: ["openai", "codex_auth", "morph"],
    boatProvider: "codex",
    capabilities: { ...COMMON_CAPABILITIES, steer: "restart" },
  },
  opencode: {
    label: "OpenCode",
    skillpackTool: "opencode",
    credentialKinds: ["opencode", "morph"],
    boatProvider: null,
    capabilities: { ...COMMON_CAPABILITIES, steer: "restart", fast: false },
  },
} as const satisfies Record<string, HarnessDescriptor>;

export type Harness = keyof typeof HARNESS_CATALOG;

/** Declaration order is part of the public launch/options contract. */
export const HARNESSES: readonly [Harness, ...Harness[]] = Object.keys(HARNESS_CATALOG) as [Harness, ...Harness[]];

/** Derive compatibility catalogs without introducing another per-harness declaration. */
export function mapHarnesses<T>(
  select: (descriptor: (typeof HARNESS_CATALOG)[Harness], id: Harness) => T,
): Record<Harness, T> {
  return Object.fromEntries(HARNESSES.map((id) => [id, select(HARNESS_CATALOG[id], id)])) as Record<Harness, T>;
}

export const HARNESS_CAPABILITIES: Readonly<Record<Harness, HarnessCapabilities>> = mapHarnesses(
  (descriptor) => descriptor.capabilities,
);

/** Validate untrusted harness identifiers while retaining the shared Harness type. */
export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
}

/** Model account classification is derived from the harness catalog, not another credential mapping. */
export type ModelCredentialKind = (typeof HARNESS_CATALOG)[Harness]["credentialKinds"][number];
export const MODEL_CREDENTIAL_KINDS: readonly ModelCredentialKind[] = [
  ...new Set(HARNESSES.flatMap((id) => [...HARNESS_CATALOG[id].credentialKinds])),
];
export function harnessForCredential(kind: CredentialKind): Harness | undefined {
  return HARNESSES.find((id) => (HARNESS_CATALOG[id].credentialKinds as readonly CredentialKind[]).includes(kind));
}

/** Every harness that can use an account; shared provider accounts are not single-harness subscriptions. */
export function harnessesForCredential(kind: CredentialKind): Harness[] {
  return HARNESSES.filter((id) => (HARNESS_CATALOG[id].credentialKinds as readonly CredentialKind[]).includes(kind));
}
