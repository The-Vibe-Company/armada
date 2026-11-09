import {
  HARNESSES,
  type Harness,
  isSandboxProvider,
  LaunchError,
  MACHINE_SIZES,
  type MachineSize,
  resolveModelChoice,
  type SandboxProviderId,
} from "@armada/core";

/** The select value that means "a model id typed in the field next to it". */
export const OTHER_MODEL = "other";

export type ModelFields = { model: string; otherModel: string; reasoningEffort: string };

export type LaunchArgs = {
  golden: string;
  /** The golden's provider, so a same-name golden of another provider is never launched instead. */
  provider: SandboxProviderId;
  org: string;
  harness: Harness;
  model: string;
  reasoning_effort: string;
  /** Connection ids (never names) whose MCP servers the sandbox gets. */
  connections?: string[];
  /** Repository context: a golden `repos[].dir` used as the native initial cwd. Absent: the default, none. */
  repo?: string;
  /**
   * The model account the sandbox runs on and keeps for every later message. Absent only on a server older than
   * named accounts, which resolves its own.
   */
  credentialId?: string;
  /** An explicit machine size; absent, the server resolves the repository, then golden default (`@armada/core`). */
  size?: MachineSize;
  /** The golden has size defaults the server must resolve: the launch needs the versioned sized route. */
  sizePolicy?: boolean;
  prompt?: string;
};

const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,80})?$/;

export type SendArgs = { model?: string; reasoning_effort?: string };

type Parsed<T> = { ok: true; args: T } | { ok: false; error: string };

/**
 * The `launch` tool's arguments from the launch form. The model and effort are always sent, so what the
 * person saw selected is what runs; the server checks them again.
 */
export function launchArgs(
  fields: {
    golden: string;
    provider: string;
    org: string;
    harness: string;
    prompt: string;
    repo?: string;
    size?: string;
  } & ModelFields,
): Parsed<Omit<LaunchArgs, "connections">> {
  const harness = HARNESSES.find((candidate) => candidate === fields.harness);
  if (!harness) return { ok: false, error: "Choose Claude Code or Codex." };
  if (!fields.golden.trim() || !fields.org.trim() || !isSandboxProvider(fields.provider)) {
    return { ok: false, error: "That request is not valid." };
  }
  const provider = fields.provider;
  const repo = fields.repo?.trim() ?? "";
  if (repo && !REPO.test(repo)) return { ok: false, error: "Choose a repository recorded in the golden." };
  const size = fields.size?.trim() ?? "";
  if (size && !(MACHINE_SIZES as readonly string[]).includes(size))
    return { ok: false, error: "Choose a machine size from the list." };
  const choice = checked(harness, chosenModel(fields), fields.reasoningEffort.trim() || undefined);
  if (!choice.ok) return choice;
  const prompt = fields.prompt.trim();
  return {
    ok: true,
    args: {
      golden: fields.golden,
      provider,
      org: fields.org,
      harness,
      ...(repo ? { repo } : {}),
      ...(size ? { size: size as MachineSize } : {}),
      model: choice.args.model,
      reasoning_effort: choice.args.reasoningEffort,
      ...(prompt ? { prompt } : {}),
    },
  };
}

/**
 * The `send` tool's optional override. Empty fields keep the sandbox's launch choice, so nothing is sent
 * for them; an effort chosen alone applies to the launch model.
 */
export function sendOverride(harness: string, fields: ModelFields, launched: string | null): Parsed<SendArgs> {
  const known = HARNESSES.find((candidate) => candidate === harness);
  const model = chosenModel(fields);
  const effort = fields.reasoningEffort.trim() || undefined;
  if (!known || (model === undefined && effort === undefined)) return { ok: true, args: {} };
  const choice = checked(known, model ?? launched ?? undefined, effort);
  if (!choice.ok) return choice;
  return {
    ok: true,
    args: {
      ...(model === undefined ? {} : { model: choice.args.model }),
      ...(effort === undefined ? {} : { reasoning_effort: choice.args.reasoningEffort }),
    },
  };
}

function chosenModel(fields: ModelFields): string | undefined {
  const value = fields.model === OTHER_MODEL ? fields.otherModel : fields.model;
  return value.trim() || undefined;
}

function checked(
  harness: Harness,
  model: string | undefined,
  reasoningEffort: string | undefined,
): Parsed<{ model: string; reasoningEffort: string }> {
  try {
    return { ok: true, args: resolveModelChoice(harness, { model, reasoningEffort }) };
  } catch (error) {
    if (error instanceof LaunchError) return { ok: false, error: error.message };
    throw error;
  }
}
