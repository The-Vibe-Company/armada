import { createHash, randomUUID } from "node:crypto";
import type { Visibility } from "./contract.ts";
import type { MemberRole } from "./database.types.ts";
import {
  type ExecResult,
  type Provider,
  ProviderError,
  type SandboxInfo,
  type SandboxState,
  type SnapshotInfo,
} from "./provider.ts";

/**
 * Goldens: a named boat.dev saved snapshot, plus the repos and init commands that build it.
 *
 * boat saved-snapshot names are account-wide and match `^[a-z0-9][a-z0-9-]{0,62}$` (63 characters,
 * reserved words included), so two orgs on one boat account, or two owners' private goldens of the
 * same name, would collide. `boatSnapshotName` namespaces each one. Visibility is Armada's rule:
 * boat still shows a private sandbox to the org. `listGoldens` and `resolveGolden` hide it from
 * everyone but the owner, admins included.
 *
 * `Provider.createGolden` starts the build sandbox with no account environment, and a fork of that
 * snapshot stays no-env. Model credentials are passed on `fork` at launch, never written here.
 * `.env` files placed in the repos before `snapshotGolden` sit on the disk and are part of the snapshot.
 */

/** Where create checks out every repo. Launch pulls the same paths. */
export const GOLDEN_WORKSPACE = "/home/user/workspace";
/** Long enough to connect and place `.env` files before the provider stops the build sandbox. */
export const GOLDEN_BUILD_TTL_SECONDS = 24 * 60 * 60;
export const SNAPSHOT_POLL_MS = 2_000;
export const SANDBOX_POLL_MS = 2_000;

/** Label on the build sandbox. Its value is `goldens.id`. */
export const LABEL_GOLDEN_ID = "armada/golden-id";
export const LABEL_PURPOSE = "armada/purpose";
export const PURPOSE_GOLDEN = "golden";

/**
 * Environment names that carry a model credential. They are injected at launch, never into a golden
 * (not as sandbox env, not in config, not in an init command).
 */
export const MODEL_CREDENTIAL_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

const SNAPSHOT_POLL_LIMIT = 450;
const SANDBOX_POLL_LIMIT = 150;
const SETUP_TIMEOUT_SECONDS = 600;
const BOAT_SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * The same words as `public.is_secret_key`: a segment that is a secret word, after lowercasing and
 * turning hyphens into underscores.
 */
const SECRET_SEGMENT =
  /(^|_)(secrets?|passwords?|passwds?|tokens?|api_keys?|apikeys?|authorizations?|credentials?|private_keys?|access_keys?|boat_api_keys?)($|_)/;

export type GoldenErrorCode =
  | "invalid_config"
  | "exists"
  | "forbidden"
  | "not_visible"
  | "not_found"
  | "not_ready"
  | "snapshot_failed"
  | "command_failed";

export class GoldenError extends Error {
  override readonly name = "GoldenError";
  readonly code: GoldenErrorCode;

  constructor(code: GoldenErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Caller {
  userId: string;
  orgId: string;
  role: MemberRole;
}

export interface GoldenRepo {
  url: string;
  branch?: string;
}

/** The `goldens.config` object: repos in checkout order, then init commands. No other keys, no secrets. */
export interface GoldenConfig {
  repos: GoldenRepo[];
  init: string[];
}

export interface GoldenRow {
  id: string;
  orgId: string;
  name: string;
  visibility: Visibility;
  ownerId: string;
  /** The namespaced boat saved-snapshot name. Null until the first successful snapshot. */
  boatSnapshotId: string | null;
  config: GoldenConfig;
  createdAt: string;
}

export interface NewGolden {
  id: string;
  orgId: string;
  name: string;
  visibility: Visibility;
  ownerId: string;
  boatSnapshotId: null;
  config: GoldenConfig;
}

/**
 * Every golden of one org, including private rows the caller must not see.
 * A service-role connection has no row level security, so the operations filter with `isGoldenVisible`.
 */
export interface GoldenStore {
  listOrg(orgId: string): Promise<GoldenRow[]>;
  insert(row: NewGolden): Promise<GoldenRow>;
  /** Replaces repos and init on a golden that has not been snapshotted. Does not change org, visibility or owner. */
  updateConfig(id: string, config: GoldenConfig): Promise<void>;
  /** Records the snapshot name. Does not change org, visibility or owner. */
  setSnapshot(id: string, boatSnapshotId: string): Promise<void>;
}

export interface GoldenDeps {
  store: GoldenStore;
  provider: Provider;
  sleep: (ms: number) => Promise<void>;
}

export interface SetupCommand {
  command: string;
  cwd?: string;
}

export interface CreatedGolden {
  golden: GoldenRow;
  sandboxId: string;
}

export interface ConnectedGolden {
  golden: GoldenRow;
  sandboxId: string;
  state: SandboxState;
  workspace: string;
  repos: { directory: string; path: string; branch?: string }[];
}

export interface SnapshottedGolden {
  golden: GoldenRow;
  snapshotName: string;
  status: "ready";
}

function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(name: string): string {
  return `golden '${name}' is not available`;
}

/** A secret-like object key at any depth, in the same shape `first_secret_key` returns. Null when there is none. */
export function secretKeyPath(value: unknown): string | null {
  return findSecretKey(value);
}

function findSecretKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSecretKey(item);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll("-", "_");
    if (SECRET_SEGMENT.test(normalized)) return key;
    const nested = findSecretKey(item);
    if (nested) return `${key}.${nested}`;
  }
  return null;
}

function uuid(value: string, label: string): string {
  const id = value.toLowerCase();
  if (!UUID.test(id)) throw new GoldenError("invalid_config", `${label} must be a uuid`);
  return id;
}

export function parseGoldenName(input: string): string {
  if (input !== input.trim() || input.length < 1 || input.length > 120) {
    throw new GoldenError("invalid_config", "a golden name is 1 to 120 characters with no surrounding space");
  }
  if (hasControl(input)) {
    throw new GoldenError("invalid_config", "a golden name cannot contain control characters");
  }
  return input;
}

/** Last path segment, without `.git`. Two repos that land on the same directory are refused by `parseGoldenConfig`. */
export function repoDirectory(url: string): string {
  const stripped = url.replace(/\.git$/, "").replace(/\/+$/, "");
  const slash = stripped.lastIndexOf("/");
  const colon = stripped.lastIndexOf(":");
  const base = stripped.slice(Math.max(slash, colon) + 1);
  if (base === "" || base.startsWith(".") || !/^[A-Za-z0-9._-]+$/.test(base)) {
    throw new GoldenError("invalid_config", `repo url '${url}' does not end in a directory name`);
  }
  return base;
}

function parseRepoUrl(value: unknown): string {
  if (typeof value !== "string" || value === "" || /\s/.test(value)) {
    throw new GoldenError("invalid_config", "a repo url must be an https, http, ssh or git@ URL");
  }
  if (value.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new GoldenError("invalid_config", "a repo url must be an https, http, ssh or git@ URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "ssh:") {
      throw new GoldenError("invalid_config", "a repo url must be https, http or ssh");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      if (!(parsed.protocol === "ssh:" && parsed.password === "")) {
        throw new GoldenError("invalid_config", "a repo url must not contain credentials");
      }
    }
    if (parsed.search !== "" || parsed.hash !== "") {
      throw new GoldenError("invalid_config", "a repo url must not contain a query or a fragment");
    }
    return value;
  }
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(value)) return value;
  throw new GoldenError("invalid_config", "a repo url must be an https, http, ssh or git@ URL");
}

function parseBranch(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith("-") || value.includes("..")) {
    throw new GoldenError("invalid_config", "a repo branch must be a plain git ref");
  }
  return value;
}

function rejectModelCredential(text: string): void {
  for (const key of MODEL_CREDENTIAL_ENV) {
    if (text.includes(key)) {
      throw new GoldenError(
        "invalid_config",
        `a golden must not mention ${key}; model credentials are injected at launch`,
      );
    }
  }
}

/** Validates the object stored in `goldens.config`. Secret-like keys are refused at any depth. */
export function parseGoldenConfig(value: unknown): GoldenConfig {
  const secret = secretKeyPath(value);
  if (secret) throw new GoldenError("invalid_config", `golden config must not contain secrets (key "${secret}")`);
  if (!isRecord(value)) throw new GoldenError("invalid_config", "golden config must be a JSON object");
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== "repos" && key !== "init") {
      throw new GoldenError("invalid_config", "golden config only allows repos and init");
    }
  }
  if (!Array.isArray(value.repos) || value.repos.length === 0) {
    throw new GoldenError("invalid_config", "golden config needs at least one repo");
  }
  const repos: GoldenRepo[] = [];
  const directories = new Set<string>();
  for (const item of value.repos) {
    if (!isRecord(item)) throw new GoldenError("invalid_config", "a repo must be an object with a url");
    for (const key of Object.keys(item)) {
      if (key !== "url" && key !== "branch")
        throw new GoldenError("invalid_config", "a repo only allows url and branch");
    }
    const url = parseRepoUrl(item.url);
    const directory = repoDirectory(url);
    if (directories.has(directory)) {
      throw new GoldenError("invalid_config", `two repos check out to '${directory}'`);
    }
    directories.add(directory);
    const repo: GoldenRepo = { url };
    if ("branch" in item && item.branch !== undefined) repo.branch = parseBranch(item.branch);
    repos.push(repo);
  }
  const init: string[] = [];
  if ("init" in value && value.init !== undefined) {
    if (!Array.isArray(value.init)) throw new GoldenError("invalid_config", "init must be an array of commands");
    for (const step of value.init) {
      if (typeof step !== "string" || step.trim() === "") {
        throw new GoldenError("invalid_config", "init commands must be non-empty strings");
      }
      rejectModelCredential(step);
      init.push(step);
    }
  }
  return { repos, init };
}

/**
 * The saved-snapshot name stored in `boat_snapshot_id`.
 * `a` + the org uuid without dashes + `-` + 12 hex chars of sha256(visibility, owner, name).
 * 46 characters, inside boat's 63, and distinct per org, owner, visibility and name.
 */
export function boatSnapshotName(golden: {
  orgId: string;
  ownerId: string;
  visibility: Visibility;
  name: string;
}): string {
  const org = uuid(golden.orgId, "org id").replaceAll("-", "");
  const owner = uuid(golden.ownerId, "owner id");
  const hash = createHash("sha256").update(`${golden.visibility}\n${owner}\n${golden.name}`).digest("hex").slice(0, 12);
  const snapshot = `a${org}-${hash}`;
  if (!BOAT_SNAPSHOT_NAME.test(snapshot)) throw new GoldenError("invalid_config", "the snapshot name is not valid");
  return snapshot;
}

export function repoCheckout(repo: GoldenRepo): { directory: string; path: string; branch?: string } {
  const directory = repoDirectory(repo.url);
  const checkout: { directory: string; path: string; branch?: string } = {
    directory,
    path: `${GOLDEN_WORKSPACE}/${directory}`,
  };
  if (repo.branch) checkout.branch = repo.branch;
  return checkout;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Clone each repo when its checkout is missing, then run init in order from the workspace. */
export function goldenSetupCommands(config: GoldenConfig): SetupCommand[] {
  const commands: SetupCommand[] = [{ command: `mkdir -p ${shellQuote(GOLDEN_WORKSPACE)}` }];
  for (const repo of config.repos) {
    const checkout = repoCheckout(repo);
    const branch = repo.branch ? ` --branch ${shellQuote(repo.branch)} --single-branch` : "";
    commands.push({
      command: `if [ ! -d ${shellQuote(`${checkout.path}/.git`)} ]; then GIT_TERMINAL_PROMPT=0 git clone${branch} ${shellQuote(repo.url)} ${shellQuote(checkout.path)}; fi`,
    });
  }
  for (const step of config.init) {
    rejectModelCredential(step);
    commands.push({ command: `bash -c ${shellQuote(step)}`, cwd: GOLDEN_WORKSPACE });
  }
  return commands;
}

/** Private goldens are visible to their owner only. An admin is not exempt. Other orgs see nothing. */
export function isGoldenVisible(
  golden: { orgId: string; visibility: Visibility; ownerId: string },
  caller: Caller,
): boolean {
  if (golden.orgId !== caller.orgId) return false;
  if (golden.visibility === "org") return true;
  return golden.ownerId === caller.userId;
}

/** Org goldens are changed by an admin. A private golden is changed by its owner. */
export function canWriteGolden(golden: GoldenRow, caller: Caller): boolean {
  if (!isGoldenVisible(golden, caller)) return false;
  if (golden.visibility === "private") return golden.ownerId === caller.userId;
  return caller.role === "admin";
}

/**
 * The golden this caller means by name. When they own a private golden and can also see an org
 * golden of the same name, the private one wins.
 */
export function selectGolden(rows: readonly GoldenRow[], caller: Caller, name: string): GoldenRow | null {
  const visible = rows.filter((row) => row.name === name && isGoldenVisible(row, caller));
  return visible.find((row) => row.visibility === "private") ?? visible.find((row) => row.visibility === "org") ?? null;
}

function normalizeCaller(caller: Caller): Caller {
  if (caller.role !== "admin" && caller.role !== "member") {
    throw new GoldenError("invalid_config", "role must be admin or member");
  }
  return { userId: uuid(caller.userId, "user id"), orgId: uuid(caller.orgId, "org id"), role: caller.role };
}

function writeDenied(golden: GoldenRow): string {
  return golden.visibility === "org"
    ? "Only an admin changes an org golden."
    : "Only the owner changes a private golden.";
}

async function load(caller: Caller, name: string, deps: GoldenDeps): Promise<GoldenRow> {
  const parsed = parseGoldenName(name);
  const rows = await deps.store.listOrg(caller.orgId);
  const visible = selectGolden(rows, caller, parsed);
  if (visible) return visible;
  const hidden = rows.some((row) => row.name === parsed);
  throw new GoldenError(hidden ? "not_visible" : "not_found", unavailable(parsed));
}

function requireWriter(golden: GoldenRow, caller: Caller): GoldenRow {
  if (!canWriteGolden(golden, caller)) {
    if (!isGoldenVisible(golden, caller)) throw new GoldenError("not_visible", unavailable(golden.name));
    throw new GoldenError("forbidden", writeDenied(golden));
  }
  return golden;
}

async function findBuildSandbox(provider: Provider, goldenId: string): Promise<SandboxInfo | null> {
  const matches: SandboxInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await provider.list({
      labels: { [LABEL_GOLDEN_ID]: goldenId, [LABEL_PURPOSE]: PURPOSE_GOLDEN },
      ...(cursor ? { cursor } : {}),
    });
    matches.push(...result.items);
    if (!result.cursor) break;
    cursor = result.cursor;
  }
  matches.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return matches.find((item) => item.state !== "failed" && item.state !== "stopped") ?? matches[0] ?? null;
}

async function waitUntilUsable(deps: GoldenDeps, sandboxId: string): Promise<SandboxInfo> {
  for (let attempt = 0; attempt < SANDBOX_POLL_LIMIT; attempt++) {
    const info = await deps.provider.get(sandboxId);
    if (info.state === "ready" || info.state === "running") return info;
    if (info.state === "failed" || info.state === "stopped") {
      throw new GoldenError("not_ready", info.error ?? `golden sandbox is ${info.state}`);
    }
    await deps.sleep(SANDBOX_POLL_MS);
  }
  throw new GoldenError("not_ready", "golden sandbox did not become ready");
}

async function openBuildSandbox(golden: GoldenRow, deps: GoldenDeps): Promise<SandboxInfo> {
  const current = await findBuildSandbox(deps.provider, golden.id);
  if (current && current.state !== "failed" && current.state !== "stopped") return waitUntilUsable(deps, current.id);
  const created = await deps.provider.createGolden({
    name: golden.name,
    ttlSeconds: GOLDEN_BUILD_TTL_SECONDS,
    idempotencyKey: current ? `golden:${golden.id}:${current.id}` : `golden:${golden.id}`,
    labels: { [LABEL_GOLDEN_ID]: golden.id, [LABEL_PURPOSE]: PURPOSE_GOLDEN },
  });
  return waitUntilUsable(deps, created.id);
}

/** Connect and snapshot only use a sandbox create already started. They never freeze a blank machine. */
async function requireBuildSandbox(golden: GoldenRow, deps: GoldenDeps): Promise<SandboxInfo> {
  const current = await findBuildSandbox(deps.provider, golden.id);
  if (!current || current.state === "failed" || current.state === "stopped") {
    throw new GoldenError("not_ready", "golden has no running build sandbox; run golden create again");
  }
  return waitUntilUsable(deps, current.id);
}

async function runSetup(deps: GoldenDeps, sandboxId: string, command: SetupCommand): Promise<void> {
  rejectModelCredential(command.command);
  let result: ExecResult;
  try {
    result = await deps.provider.exec({
      sandboxId,
      command: command.command,
      timeoutSeconds: SETUP_TIMEOUT_SECONDS,
      ...(command.cwd ? { cwd: command.cwd } : {}),
    });
  } catch (error) {
    if (error instanceof ProviderError) throw new GoldenError("command_failed", error.message);
    throw error;
  }
  if (result.detached || result.timedOut || result.exitCode !== 0) {
    const why = result.detached ? "detached" : result.timedOut ? "timed out" : `exit ${result.exitCode}`;
    throw new GoldenError("command_failed", `golden setup failed (${why})`);
  }
}

async function prepare(golden: GoldenRow, sandboxId: string, deps: GoldenDeps): Promise<void> {
  for (const command of goldenSetupCommands(golden.config)) {
    await runSetup(deps, sandboxId, command);
  }
}

async function ensureRow(
  caller: Caller,
  name: string,
  visibility: Visibility,
  config: GoldenConfig,
  deps: GoldenDeps,
): Promise<GoldenRow> {
  const rows = await deps.store.listOrg(caller.orgId);
  const visible = selectGolden(rows, caller, name);
  if (visible) {
    if (!canWriteGolden(visible, caller)) throw new GoldenError("forbidden", writeDenied(visible));
    if (visible.boatSnapshotId || visible.visibility !== visibility) {
      throw new GoldenError("exists", `golden '${name}' already exists`);
    }
    if (JSON.stringify(visible.config) !== JSON.stringify(config)) {
      await deps.store.updateConfig(visible.id, config);
      return { ...visible, config };
    }
    return visible;
  }
  try {
    return await deps.store.insert({
      id: randomUUID(),
      orgId: caller.orgId,
      name,
      visibility,
      ownerId: caller.userId,
      boatSnapshotId: null,
      config,
    });
  } catch (error) {
    if (error instanceof GoldenError && error.code === "exists") throw error;
    throw error;
  }
}

/**
 * Creates the golden row and its build sandbox, clones each repo and runs init.
 * An unsnapshotted golden is resumed: the same sandbox is reused, and init runs again.
 */
export async function createGolden(
  input: { caller: Caller; name: string; visibility: Visibility; config: GoldenConfig },
  deps: GoldenDeps,
): Promise<CreatedGolden> {
  const caller = normalizeCaller(input.caller);
  const name = parseGoldenName(input.name);
  const config = parseGoldenConfig(input.config);
  if (input.visibility === "org" && caller.role !== "admin") {
    throw new GoldenError("forbidden", "Only an admin creates an org golden.");
  }
  const golden = await ensureRow(caller, name, input.visibility, config, deps);
  const sandbox = await openBuildSandbox(golden, deps);
  await prepare(golden, sandbox.id, deps);
  return { golden, sandboxId: sandbox.id };
}

/** The build sandbox a person shells into to place `.env` files. Does not copy any credential in. */
export async function connectGolden(caller: Caller, name: string, deps: GoldenDeps): Promise<ConnectedGolden> {
  const who = normalizeCaller(caller);
  const golden = requireWriter(await load(who, name, deps), who);
  const sandbox = await requireBuildSandbox(golden, deps);
  return {
    golden,
    sandboxId: sandbox.id,
    state: sandbox.state,
    workspace: GOLDEN_WORKSPACE,
    repos: golden.config.repos.map(repoCheckout),
  };
}

/** Freezes the build sandbox and records the namespaced snapshot name. Polls until the save settles. */
export async function snapshotGolden(caller: Caller, name: string, deps: GoldenDeps): Promise<SnapshottedGolden> {
  const who = normalizeCaller(caller);
  const golden = requireWriter(await load(who, name, deps), who);
  const sandbox = await requireBuildSandbox(golden, deps);
  const snapshotName = boatSnapshotName(golden);
  if (golden.boatSnapshotId && golden.boatSnapshotId !== snapshotName) {
    throw new GoldenError("snapshot_failed", "the stored snapshot name does not match this golden");
  }
  const settled = await saveSnapshot(deps, sandbox.id, snapshotName);
  if (settled.status === "failed") {
    throw new GoldenError("snapshot_failed", settled.error ?? "snapshot failed");
  }
  await deps.store.setSnapshot(golden.id, snapshotName);
  return { golden: { ...golden, boatSnapshotId: snapshotName }, snapshotName, status: "ready" };
}

async function saveSnapshot(deps: GoldenDeps, sandboxId: string, snapshotName: string): Promise<SnapshotInfo> {
  let info: SnapshotInfo;
  try {
    info = await deps.provider.snapshot({ sandboxId, name: snapshotName });
  } catch (error) {
    if (!(error instanceof ProviderError) || error.code !== "conflict") throw error;
    info = await deps.provider.getSnapshot(snapshotName);
  }
  for (let attempt = 0; info.status === "saving" && attempt < SNAPSHOT_POLL_LIMIT; attempt++) {
    await deps.sleep(SNAPSHOT_POLL_MS);
    info = await deps.provider.getSnapshot(snapshotName);
  }
  if (info.status === "saving") throw new GoldenError("snapshot_failed", "snapshot is still saving");
  return info;
}

export async function listGoldens(caller: Caller, deps: GoldenDeps): Promise<GoldenRow[]> {
  const who = normalizeCaller(caller);
  const rows = await deps.store.listOrg(who.orgId);
  return rows
    .filter((row) => isGoldenVisible(row, who))
    .sort((a, b) => a.name.localeCompare(b.name) || a.visibility.localeCompare(b.visibility));
}

/**
 * The golden a launch may fork. A private golden of someone else, including an admin, is refused
 * with `not_visible` even when the store can see the row.
 */
export async function resolveGolden(caller: Caller, name: string, deps: GoldenDeps): Promise<GoldenRow> {
  return load(normalizeCaller(caller), name, deps);
}
