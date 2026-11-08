import type { Visibility } from "./contract.ts";
import type { MemberRole } from "./database.types.ts";
import {
  boatSnapshotName,
  cloneCommand,
  GOLDEN_BUILD_TTL_SECONDS,
  GOLDEN_POLL_MS,
  GOLDEN_SANDBOX_POLLS,
  GOLDEN_SNAPSHOT_POLLS,
  type GoldenConfig,
  GoldenError,
  initCommand,
  parseGoldenName,
} from "./golden-config.ts";
import { type Provider, ProviderError, type SandboxInfo } from "./provider.ts";

export interface GoldenActor {
  userId: string;
  orgId: string;
  role: MemberRole;
}

/** A golden the caller is allowed to see. `config` is the parsed, secret-free file. */
export interface GoldenRecord {
  id: string;
  orgId: string;
  name: string;
  visibility: Visibility;
  ownerId: string;
  boatSnapshotId: string | null;
  boatSandboxId: string | null;
  config: GoldenConfig;
  createdAt: string;
}

export interface GoldenStore {
  list(orgId: string): Promise<GoldenRecord[]>;
  /** Every visible golden of this name. An org golden and the caller's private one can share it. */
  findByName(orgId: string, name: string): Promise<GoldenRecord[]>;
  insert(input: {
    orgId: string;
    name: string;
    visibility: Visibility;
    ownerId: string;
    config: GoldenConfig;
  }): Promise<GoldenRecord>;
  /** Replaces the config of a golden whose sandbox has not been recorded yet. */
  setConfig(id: string, config: GoldenConfig): Promise<void>;
  setSandbox(id: string, boatSandboxId: string): Promise<void>;
  setSnapshot(id: string, boatSnapshotId: string): Promise<void>;
}

export interface GoldenLimits {
  sleep?: (ms: number) => Promise<void>;
  sandboxPolls?: number;
  snapshotPolls?: number;
}

export interface CreatedGolden {
  golden: GoldenRecord;
  sandboxId: string;
  snapshotName: string;
}

export interface SnapshottedGolden {
  golden: GoldenRecord;
  snapshotName: string;
}

const READY = new Set<SandboxInfo["state"]>(["ready", "running"]);

/**
 * Builds the master sandbox, clones each repo and runs init. Model credentials are not passed:
 * the provider creates the sandbox with no account environment.
 * A retry after a lost sandbox id uses the golden's id as the idempotency key.
 */
export async function createGolden(
  provider: Provider,
  store: GoldenStore,
  actor: GoldenActor,
  input: { name: string; visibility: Visibility; config: GoldenConfig },
  limits: GoldenLimits = {},
): Promise<CreatedGolden> {
  const name = parseGoldenName(input.name);
  if (input.visibility === "org" && actor.role !== "admin") {
    throw new GoldenError(
      "forbidden",
      "Only an admin can create an org golden. Pass --private for one only you can see.",
    );
  }
  const existing = (await store.findByName(actor.orgId, name)).filter((row) => row.visibility === input.visibility);
  const golden = await goldenRow(store, actor, name, input.visibility, input.config, existing);
  if (golden.boatSandboxId) {
    throw new GoldenError(
      "conflict",
      `Golden '${name}' already exists. Run 'armada golden connect ${name}' or 'armada golden snapshot ${name}'.`,
    );
  }
  const snapshotName = boatSnapshotName({
    orgId: actor.orgId,
    ownerId: actor.userId,
    visibility: input.visibility,
    name,
  });
  const sandbox = await provider.createGolden({
    name,
    ttlSeconds: GOLDEN_BUILD_TTL_SECONDS,
    idempotencyKey: golden.id,
    labels: {
      armada: "golden",
      org: actor.orgId,
      owner: actor.userId,
      visibility: input.visibility,
      golden: name,
      snapshot: snapshotName,
    },
  });
  await store.setSandbox(golden.id, sandbox.id);
  const ready = READY.has(sandbox.state) ? sandbox : await waitReady(provider, sandbox.id, limits);
  await setup(provider, ready.id, input.config);
  return {
    golden: { ...golden, boatSandboxId: sandbox.id },
    sandboxId: sandbox.id,
    snapshotName,
  };
}

/** The running master sandbox, so a person can place `.env` files before the snapshot. */
export async function connectGolden(
  provider: Provider,
  store: GoldenStore,
  actor: GoldenActor,
  name: string,
  limits: GoldenLimits = {},
): Promise<{ golden: GoldenRecord; sandbox: SandboxInfo }> {
  const golden = await oneVisible(store, actor.orgId, parseGoldenName(name));
  assertCanChange(actor, golden);
  if (!golden.boatSandboxId) {
    throw new GoldenError("conflict", `Golden '${golden.name}' has no sandbox yet.`);
  }
  const sandbox = await waitReady(provider, golden.boatSandboxId, limits);
  return { golden, sandbox };
}

/**
 * Freezes the master sandbox under its namespaced boat name and records that name.
 * The save is asynchronous: this polls until the snapshot is ready or failed.
 * Saving the same name again replaces the artifact.
 */
export async function snapshotGolden(
  provider: Provider,
  store: GoldenStore,
  actor: GoldenActor,
  name: string,
  limits: GoldenLimits = {},
): Promise<SnapshottedGolden> {
  const golden = await oneVisible(store, actor.orgId, parseGoldenName(name));
  assertCanChange(actor, golden);
  if (!golden.boatSandboxId) {
    throw new GoldenError("conflict", `Golden '${golden.name}' has no sandbox yet. Create it first.`);
  }
  const snapshotName = boatSnapshotName({
    orgId: golden.orgId,
    ownerId: golden.ownerId,
    visibility: golden.visibility,
    name: golden.name,
  });
  let status: "saving" | "ready" | "failed" = "saving";
  try {
    const started = await provider.snapshot({ sandboxId: golden.boatSandboxId, name: snapshotName });
    status = started.status;
  } catch (error) {
    if (!saveInProgress(error)) throw error;
  }
  if (status === "saving") {
    const settled = await waitSnapshot(provider, snapshotName, limits);
    status = settled.status;
    if (status === "failed") {
      throw new GoldenError("snapshot_failed", settled.error ?? `Snapshot of '${golden.name}' failed.`);
    }
  }
  if (status === "failed") throw new GoldenError("snapshot_failed", `Snapshot of '${golden.name}' failed.`);
  await store.setSnapshot(golden.id, snapshotName);
  return { golden: { ...golden, boatSnapshotId: snapshotName }, snapshotName };
}

/**
 * The golden a launch may fork. A private golden of someone else is absent, same as a missing name.
 * Launch (#462) and the MCP server (#464) call this under the caller's own database role.
 */
export async function goldenForLaunch(store: GoldenStore, actor: GoldenActor, name: string): Promise<GoldenRecord> {
  const golden = await oneVisible(store, actor.orgId, parseGoldenName(name));
  if (!golden.boatSnapshotId) {
    throw new GoldenError("conflict", `Golden '${golden.name}' has no snapshot yet.`);
  }
  return golden;
}

async function goldenRow(
  store: GoldenStore,
  actor: GoldenActor,
  name: string,
  visibility: Visibility,
  config: GoldenConfig,
  existing: GoldenRecord[],
): Promise<GoldenRecord> {
  if (existing.length > 1) {
    throw new GoldenError("conflict", `More than one ${visibility} golden is named '${name}'.`);
  }
  const row = existing[0];
  if (!row) return store.insert({ orgId: actor.orgId, name, visibility, ownerId: actor.userId, config });
  if (!row.boatSandboxId) {
    await store.setConfig(row.id, config);
    return { ...row, config };
  }
  return row;
}

async function oneVisible(store: GoldenStore, orgId: string, name: string): Promise<GoldenRecord> {
  const rows = await store.findByName(orgId, name);
  const row = rows[0];
  if (!row) throw new GoldenError("not_found", `No golden named '${name}'.`);
  if (rows.length > 1) {
    throw new GoldenError(
      "conflict",
      `More than one golden is named '${name}'. The org one and your private one need different names.`,
    );
  }
  return row;
}

function assertCanChange(actor: GoldenActor, golden: GoldenRecord): void {
  if (golden.visibility === "private") {
    if (golden.ownerId !== actor.userId) throw new GoldenError("not_found", `No golden named '${golden.name}'.`);
    return;
  }
  if (actor.role !== "admin") {
    throw new GoldenError("forbidden", "Only an admin can change an org golden.");
  }
}

export async function waitReady(provider: Provider, sandboxId: string, limits: GoldenLimits): Promise<SandboxInfo> {
  const sleep = limits.sleep ?? delay;
  const polls = limits.sandboxPolls ?? GOLDEN_SANDBOX_POLLS;
  for (let attempt = 0; attempt < polls; attempt++) {
    const info = await provider.get(sandboxId);
    if (READY.has(info.state)) return info;
    if (info.state !== "starting") {
      throw new GoldenError(
        "setup_failed",
        `Sandbox ${sandboxId} is ${info.state}${info.error ? `: ${info.error}` : ""}.`,
      );
    }
    await sleep(GOLDEN_POLL_MS);
  }
  throw new GoldenError("setup_failed", `Sandbox ${sandboxId} is still starting.`);
}

async function waitSnapshot(
  provider: Provider,
  name: string,
  limits: GoldenLimits,
): Promise<{ status: "ready" | "failed"; error?: string }> {
  const sleep = limits.sleep ?? delay;
  const polls = limits.snapshotPolls ?? GOLDEN_SNAPSHOT_POLLS;
  for (let attempt = 0; attempt < polls; attempt++) {
    const info = await provider.getSnapshot(name);
    if (info.status === "ready") return { status: "ready" };
    if (info.status === "failed") return info.error ? { status: "failed", error: info.error } : { status: "failed" };
    await sleep(GOLDEN_POLL_MS);
  }
  throw new GoldenError("snapshot_failed", `Snapshot '${name}' is still saving.`);
}

async function setup(provider: Provider, sandboxId: string, config: GoldenConfig): Promise<void> {
  for (const repo of config.repos) {
    const command = cloneCommand(repo);
    await runCommand(provider, sandboxId, command.command, command.cwd, command.timeoutSeconds, `clone ${repo.url}`);
  }
  for (const [index, command] of config.init.entries()) {
    const spec = initCommand(command);
    await runCommand(provider, sandboxId, spec.command, spec.cwd, spec.timeoutSeconds, `init command ${index + 1}`);
  }
}

async function runCommand(
  provider: Provider,
  sandboxId: string,
  command: string,
  cwd: string,
  timeoutSeconds: number,
  label: string,
): Promise<void> {
  const result = await provider.exec({ sandboxId, command, cwd, timeoutSeconds });
  if (result.detached) {
    throw new GoldenError("setup_failed", `${label} started in the background.`);
  }
  if (result.timedOut) throw new GoldenError("setup_failed", `${label} timed out.`);
  if (result.exitCode !== 0) {
    const detail = clip(result.stderr || result.stdout);
    throw new GoldenError(
      "setup_failed",
      detail ? `${label} failed (exit ${result.exitCode}): ${detail}` : `${label} failed (exit ${result.exitCode}).`,
    );
  }
}

function saveInProgress(error: unknown): boolean {
  return error instanceof ProviderError && error.code === "conflict" && error.providerCode === "save_in_progress";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clip(value: string): string {
  const oneLine = value.replaceAll(/\s+/g, " ").trim();
  if (oneLine === "") return "";
  return oneLine.length <= 400 ? oneLine : `${oneLine.slice(0, 400)}...`;
}
