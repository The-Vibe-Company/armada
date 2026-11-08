import { HARNESSES, type Harness } from "./contract.ts";
import { CODEX_AUTH_ENV, type HarnessCredentials, redact } from "./credentials.ts";
import {
  type GoldenActor,
  type GoldenLimits,
  type GoldenRecord,
  type GoldenStore,
  goldenForLaunch,
  waitReady,
} from "./golden.ts";
import { GOLDEN_ROOT, GoldenError, initCommand, pullCommand, type ShellCommand } from "./golden-config.ts";
import { LaunchError } from "./launch-error.ts";
import type { Provider } from "./provider.ts";
import type { SandboxRecord, SandboxStore } from "./sandbox.ts";

/** Four hours: long enough for an autonomous run, short enough that a forgotten sandbox stops by itself. */
export const DEFAULT_LAUNCH_TTL_SECONDS = 14_400;

/** The longest TTL boat accepts: 30 days. */
export const MAX_LAUNCH_TTL_SECONDS = 2_592_000;

const OUTPUT_LIMIT = 2000;

export interface LaunchRequest {
  /** The golden's human name. Resolved under the caller's own visibility, never by a provider id. */
  golden: string;
  harness: Harness;
  /** With a prompt the agent starts at once. Without one the sandbox is left ready for the first `send`. */
  prompt?: string;
  ttlSeconds?: number;
}

/** Resolves what the sandbox receives. `armada launch` builds it from `resolveCredentials`. */
export interface LaunchCredentialResolver {
  resolve(actor: GoldenActor, harness: Harness): Promise<HarnessCredentials>;
}

export interface LaunchStores {
  goldens: GoldenStore;
  sandboxes: SandboxStore;
  credentials: LaunchCredentialResolver;
}

export interface LaunchResult {
  sandbox: SandboxRecord;
  golden: GoldenRecord;
  ttlSeconds: number;
  /** When the provider stops the sandbox by itself. */
  expiresAt?: Date;
  /** Set when a prompt was sent. */
  conversationId?: string;
  promptId?: string;
}

export interface LaunchOptions extends GoldenLimits {
  /** For tests. */
  newId?: () => string;
}

/**
 * Forks a golden into a sandbox, brings its repos up to date, runs its init commands and, with a
 * prompt, starts the agent.
 *
 * The caller's own database role does the reads and writes: a private golden of someone else is
 * `not_found`. The fork starts from the stored snapshot name, gets `noEnv` and an environment with
 * only the credentials of this harness (user over org), and never writes them to the golden. A fork
 * inherits neither TTL nor labels, so both are set here. When anything fails after the fork the
 * sandbox is recorded as `failed` and its machine is stopped.
 */
export async function launchSandbox(
  provider: Provider,
  stores: LaunchStores,
  actor: GoldenActor,
  request: LaunchRequest,
  options: LaunchOptions = {},
): Promise<LaunchResult> {
  const harness = checkHarness(provider, request.harness);
  const ttlSeconds = checkTtl(request.ttlSeconds ?? DEFAULT_LAUNCH_TTL_SECONDS);
  const prompt = checkPrompt(request.prompt);

  const golden = await goldenForLaunch(stores.goldens, actor, request.golden);
  if (golden.visibility === "private" && golden.ownerId !== actor.userId) {
    throw new GoldenError("not_found", `No golden named '${golden.name}'.`);
  }
  const snapshot = golden.boatSnapshotId;
  if (!snapshot) throw new GoldenError("conflict", `Golden '${golden.name}' has no snapshot yet.`);
  const credentials = await stores.credentials.resolve(actor, harness);

  const id = (options.newId ?? (() => crypto.randomUUID()))();
  const forked = await provider.fork({
    from: snapshot,
    noEnv: true,
    env: credentials.env,
    ttlSeconds,
    labels: {
      armada: "sandbox",
      sandbox: id,
      org: actor.orgId,
      owner: actor.userId,
      golden: golden.name,
      visibility: golden.visibility,
      harness,
    },
  });

  let record: SandboxRecord;
  try {
    record = await stores.sandboxes.insert({
      id,
      boatId: forked.id,
      goldenId: golden.id,
      orgId: golden.orgId,
      ownerId: actor.userId,
      harness,
      status: "starting",
    });
  } catch (error) {
    await quietly(() => provider.delete({ sandboxId: forked.id }));
    throw error;
  }

  try {
    const ready = await waitReady(provider, forked.id, options);
    if (credentials.codexAuthJson) await writeCodexAuth(provider, ready.id, credentials.secrets);
    await setup(provider, ready.id, golden, credentials.secrets);
    if (prompt === undefined) {
      await stores.sandboxes.update(record.id, { status: "ready" });
      return finish(record, golden, ttlSeconds, ready.expiresAt ?? forked.expiresAt, "ready", [], undefined);
    }
    const receipt = await provider.prompt({ sandboxId: ready.id, harness, text: prompt }).catch((error: unknown) => {
      throw new LaunchError(
        "prompt_failed",
        `The agent could not be started: ${redact(messageOf(error), credentials.secrets)}`,
        { cause: error },
      );
    });
    await stores.sandboxes.update(record.id, { status: "running", conversationIds: [receipt.conversationId] });
    return finish(
      record,
      golden,
      ttlSeconds,
      ready.expiresAt ?? forked.expiresAt,
      "running",
      [receipt.conversationId],
      {
        conversationId: receipt.conversationId,
        promptId: receipt.promptId,
      },
    );
  } catch (error) {
    const failure = withSandbox(error, record.id, credentials.secrets);
    await quietly(() => stores.sandboxes.update(record.id, { status: "failed", statusReason: failure.message }));
    await quietly(() => provider.stop({ sandboxId: forked.id }));
    throw failure;
  }
}

function finish(
  record: SandboxRecord,
  golden: GoldenRecord,
  ttlSeconds: number,
  expiresAt: Date | undefined,
  status: SandboxRecord["status"],
  conversationIds: string[],
  prompt: { conversationId: string; promptId: string } | undefined,
): LaunchResult {
  return {
    sandbox: { ...record, status, conversationIds },
    golden,
    ttlSeconds,
    ...(expiresAt ? { expiresAt } : {}),
    ...(prompt ?? {}),
  };
}

async function setup(
  provider: Provider,
  sandboxId: string,
  golden: GoldenRecord,
  secrets: readonly string[],
): Promise<void> {
  for (const repo of golden.config.repos) {
    await run(provider, sandboxId, pullCommand(repo), `git pull of ${repo.dir}`, secrets);
  }
  for (const [index, command] of golden.config.init.entries()) {
    await run(provider, sandboxId, initCommand(command), `init command ${index + 1}`, secrets);
  }
}

async function writeCodexAuth(provider: Provider, sandboxId: string, secrets: readonly string[]): Promise<void> {
  const dir = `${GOLDEN_ROOT}/.codex`;
  const command = `umask 077 && mkdir -p ${dir} && printf '%s' "$${CODEX_AUTH_ENV}" > ${dir}/auth.json`;
  const result = await provider.exec({ sandboxId, command, cwd: GOLDEN_ROOT, timeoutSeconds: 60 });
  if (result.detached || result.timedOut || result.exitCode !== 0) {
    throw new LaunchError("start_failed", redact("Codex auth.json could not be written in the sandbox.", secrets));
  }
}

async function run(
  provider: Provider,
  sandboxId: string,
  spec: ShellCommand,
  label: string,
  secrets: readonly string[],
): Promise<void> {
  const result = await provider.exec({
    sandboxId,
    command: spec.command,
    cwd: spec.cwd,
    timeoutSeconds: spec.timeoutSeconds,
  });
  if (result.detached) throw new LaunchError("init_failed", `${label} started in the background.`);
  if (result.timedOut) {
    throw new LaunchError("init_failed", `${label} timed out.${output(result.stderr, result.stdout, secrets)}`);
  }
  if (result.exitCode !== 0) {
    throw new LaunchError(
      "init_failed",
      `${label} failed (exit ${result.exitCode}).${output(result.stderr, result.stdout, secrets)}`,
    );
  }
}

function output(stderr: string, stdout: string, secrets: readonly string[]): string {
  const text = redact([stderr.trim(), stdout.trim()].filter(Boolean).join("\n"), secrets).trim();
  if (text === "") return "";
  const tail = text.length <= OUTPUT_LIMIT ? text : `...${text.slice(-OUTPUT_LIMIT)}`;
  return `\n${tail}`;
}

function withSandbox(error: unknown, sandboxId: string, secrets: readonly string[]): LaunchError {
  if (error instanceof LaunchError) {
    return error.sandboxId === sandboxId
      ? error
      : new LaunchError(error.code, error.message, { cause: error.cause, sandboxId });
  }
  return new LaunchError("start_failed", `The sandbox could not be started: ${redact(messageOf(error), secrets)}`, {
    cause: error,
    sandboxId,
  });
}

async function quietly(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // The launch already failed; the original error is the one to report.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkHarness(provider: Provider, harness: string): Harness {
  if (
    !(HARNESSES as readonly string[]).includes(harness) ||
    !(provider.harnesses as readonly string[]).includes(harness)
  ) {
    throw new LaunchError("invalid_request", `Unknown agent '${harness}'. Use one of: ${HARNESSES.join(", ")}.`);
  }
  return harness as Harness;
}

function checkTtl(ttlSeconds: number): number {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_LAUNCH_TTL_SECONDS) {
    throw new LaunchError(
      "invalid_request",
      `The TTL must be a whole number of seconds from 1 to ${MAX_LAUNCH_TTL_SECONDS} (30 days).`,
    );
  }
  return ttlSeconds;
}

function checkPrompt(prompt: string | undefined): string | undefined {
  if (prompt === undefined) return undefined;
  if (prompt.trim() === "") {
    throw new LaunchError("invalid_request", "The prompt is empty. Leave it out to launch an idle sandbox.");
  }
  return prompt;
}
