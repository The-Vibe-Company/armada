import type { CredentialKind } from "./database.types.ts";
import type { HarnessModels } from "./models.ts";
import type { HarnessCapabilities } from "./provider.ts";

/** Browser-safe harness metadata. Driver implementations and SQL enums remain at their native boundaries. */
interface HarnessDescriptor extends HarnessModels {
  credentialKinds: readonly CredentialKind[];
  label: string;
  boatProvider: string;
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

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

export const HARNESS_CATALOG = {
  claude: {
    label: "Claude Code",
    credentialKinds: ["claude_oauth", "anthropic"],
    boatProvider: "claude-code",
    capabilities: { ...COMMON_CAPABILITIES, steer: "native" },
    defaultModel: "claude-opus-5-5",
    defaultReasoningEffort: "medium",
    reasoningEfforts: CLAUDE_EFFORTS,
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", reasoningEfforts: CLAUDE_EFFORTS },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", reasoningEfforts: CLAUDE_EFFORTS },
    ],
  },
  codex: {
    label: "Codex",
    credentialKinds: ["openai", "codex_auth"],
    boatProvider: "codex",
    capabilities: { ...COMMON_CAPABILITIES, steer: "restart" },
    defaultModel: "gpt-6.1-sol",
    defaultReasoningEffort: "medium",
    reasoningEfforts: CODEX_EFFORTS,
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", reasoningEfforts: CODEX_EFFORTS },
      { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", reasoningEfforts: CODEX_EFFORTS },
      { id: "gpt-6-astra", label: "GPT-6 Astra", reasoningEfforts: CODEX_EFFORTS },
      { id: "gpt-6-sol", label: "GPT-6 Sol", reasoningEfforts: CODEX_EFFORTS },
      { id: "gpt-6-luna", label: "GPT-6 Luna", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    ],
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
