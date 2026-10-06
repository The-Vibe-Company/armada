import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  type ArmadaConfig,
  type ClaimRef,
  type Delivery,
  type Fleet,
  type HerdrProfile,
  type PendingLaunch,
  RuntimeError,
  type RuntimeHandle,
  type RuntimeName,
  type RuntimeState,
  redactSecrets,
  runtimeNameOf,
} from "@armada/core";
import { type HerdrClaimHandle, HerdrError } from "../herdr.ts";
import { type Io, UsageError } from "../io.ts";
import { ClaudeCodeAdapter } from "./claude-code.ts";
import { ConductorAdapter } from "./conductor.ts";
import { HerdrAdapter } from "./herdr.ts";

export type ParsedHandle = HerdrClaimHandle | { workspace: string; session: string };
export interface PreflightInput {
  profile: ResolvedProfile;
  repository: string;
}
export interface PreflightCheck {
  level: "ok" | "warning" | "error";
  message: string;
  fix: string | null;
}
export interface ResolvedProfile {
  name: string;
  agent: string;
  model: string;
  effort: string;
  fastMode: boolean;
  herdr?: HerdrProfile;
}
export interface LaunchSpec {
  ticket: string;
  title: string;
  repository: string;
  base: string;
  projectId?: string | null;
  branch: string;
  /** A fresh local replacement must avoid the old worktree path and registered agent name. */
  herdrTarget?: { path: string; agent: string };
  from: { kind: "base" } | { kind: "branch"; head: string } | { kind: "in-place"; previous: ClaimRef };
  profile: ResolvedProfile;
  prompt: string;
  env: Record<string, string>;
  blankSecrets: string[];
}
export interface Launched {
  handle: string;
  link: string | null;
  path: string | null;
  state: RuntimeState;
}
export interface LaunchRecovery {
  workers: Launched[];
  /** Safe workspace/session ids for a manual decision, including incomplete searches. */
  candidates: string[];
  complete: boolean;
}
export interface OutgoingMessage {
  text: string;
  key: string;
  kind: "answer" | "note" | "login";
}
export type { Delivery } from "@armada/core";
export interface RuntimeReading {
  state: RuntimeState;
  since: string | null;
  sequence?: number;
  detail: string;
}
export interface Peek extends RuntimeReading {
  link: string | null;
  lastReply: { at: string | null; text: string } | null;
  actions: {
    id?: string;
    at: string | null;
    kind: "command" | "tool" | "message";
    text: string;
    exit?: number | null;
  }[];
  /** Completion updates for Claude tools started before the caller's cursor. Not user-facing text. */
  actionResults?: { id: string; exit: number | null }[];
  cursor: string | null;
  truncated: boolean;
}
export interface ArchiveOptions {
  reason: "merged" | "released" | "relaunched";
  whenWorking: "wait" | "cancel" | "refuse";
  waitMs: number;
  /** A fresh replacement owns another workspace; in-place cleanup touches one session only. */
  workspace?: boolean;
}
export interface Archived {
  archived: boolean;
  alreadyGone: boolean;
  path: string | null;
}
export interface RuntimeAdapter {
  readonly name: RuntimeName;
  readonly guide: string;
  readonly can: Readonly<{
    launch: boolean;
    resumeInPlace: boolean;
    deliver: boolean;
    observe: boolean;
    peek: boolean;
    cancel: boolean;
    archive: boolean;
  }>;
  parse(handle: string): ParsedHandle;
  preflight(input: PreflightInput): Promise<PreflightCheck[]>;
  resumeState?(target: ClaimRef): Promise<{ ready: boolean; clean: boolean; path: string | null }>;
  launch(spec: LaunchSpec): Promise<Launched>;
  /** Read-only recovery after create may have succeeded; never retries a launch. */
  recoverLaunch?(spec: LaunchSpec, since: string): Promise<LaunchRecovery>;
  deliver(target: ClaimRef, message: OutgoingMessage): Promise<Delivery>;
  observe(target: ClaimRef): Promise<RuntimeReading>;
  peek(target: ClaimRef, options: { actions: number; cursor: string | null }): Promise<Peek>;
  cancel(target: ClaimRef, options: { waitMs: number }): Promise<{ wasWorking: boolean; state: RuntimeState }>;
  archive(target: ClaimRef, options: ArchiveOptions): Promise<Archived>;
}

export function runtimeFor(
  io: Io,
  config: ArmadaConfig | undefined,
  runtime: string,
  secretValues: readonly string[] = [],
): RuntimeAdapter {
  const values = [
    ...secretValues,
    ...(config?.secrets.names ?? []).map((n) => io.env[n]).filter((v): v is string => !!v),
  ];
  switch (runtimeNameOf(runtime)) {
    case "conductor":
      return new ConductorAdapter(io, values);
    case "herdr":
      return herdrErrors(new HerdrAdapter(io, config, values));
    case "claude-code":
      return new ClaudeCodeAdapter();
    default:
      throw new RuntimeError(
        "this worker runtime is unsupported; use its runtime guide",
        "unsupported",
        "armada status",
      );
  }
}
export function claimRef(h: RuntimeHandle): ClaimRef {
  const runtime = runtimeNameOf(h.runtime);
  if (!runtime) throw new RuntimeError("this worker runtime is unsupported", "unsupported", "armada status");
  return {
    ticket: h.ticket,
    runtime,
    handle: h.handle,
    claimedAt: h.claimedAt,
    launchId: h.workerSessionId ?? null,
    releasedAt: h.releasedAt,
    branch: h.branch,
  };
}
export function launchRef(l: PendingLaunch): ClaimRef {
  const runtime = runtimeNameOf(l.runtime);
  if (!runtime || !l.handle || !l.id)
    throw new RuntimeError("the launch has no bound runtime identity", "invalid", "armada status");
  return { ticket: l.ticket, runtime, handle: l.handle, claimedAt: null, launchId: l.id, releasedAt: null };
}
/** Non-secret recovery identity for exactly this generation, including its ended state. */
export function archiveClaimKey(ref: ClaimRef): string {
  return createHash("sha256")
    .update(JSON.stringify([ref.ticket, ref.runtime, ref.handle, ref.claimedAt, ref.launchId, ref.releasedAt]))
    .digest("hex");
}

export function sharesRuntimeWorkspace(ref: ClaimRef, other: Pick<RuntimeHandle, "runtime" | "handle">): boolean {
  return (
    ref.handle === other.handle ||
    (ref.runtime === "conductor" &&
      runtimeNameOf(other.runtime) === "conductor" &&
      ref.handle.split("/")[0] === other.handle.split("/")[0])
  );
}

const stale = (ticket: string) =>
  new RuntimeError(`${ticket}'s claim changed; left the runtime untouched`, "stale", "armada inbox");
const leases = new AsyncLocalStorage<() => Promise<void>>();
/** Relaunch keeps its launch/merge leases through every native write. */
export function withRuntimeLease<T>(check: () => Promise<void>, act: () => Promise<T>): Promise<T> {
  return leases.run(check, act);
}
const guards = new AsyncLocalStorage<{
  fleet: Fleet;
  expected: ClaimRef;
  rule: "active" | "ended";
  allowHistorical: boolean;
}>();
function same(a: ClaimRef, b: ClaimRef): boolean {
  return (
    a.ticket === b.ticket &&
    a.runtime === b.runtime &&
    a.handle === b.handle &&
    a.claimedAt === b.claimedAt &&
    a.launchId === b.launchId &&
    a.releasedAt === b.releasedAt &&
    // Pending launches have no recorded branch; native herdr provenance still
    // checks the supplied checkout branch. A claimed generation pins it here.
    (a.claimedAt === null || (a.branch ?? null) === (b.branch ?? null))
  );
}
async function checkClaim(fleet: Fleet, expected: ClaimRef, rule: "active" | "ended", allowHistorical = false) {
  const h = await fleet.runtimeHandle(expected.ticket);
  if (expected.claimedAt === null && rule === "active") {
    if (h && !h.releasedAt) throw stale(expected.ticket);
    const launch = (await fleet.pendingLaunches()).find((l) => l.ticket === expected.ticket);
    if (!launch?.id || !launch.handle || !launch.runtime || !same(launchRef(launch), expected))
      throw stale(expected.ticket);
    return;
  }
  if (expected.claimedAt === null && !allowHistorical) throw stale(expected.ticket);
  if (allowHistorical && rule === "ended") {
    const [handles, pending] = await Promise.all([fleet.runtimeHandles(), fleet.pendingLaunches()]);
    if (
      handles.some((open) => open.handle === expected.handle) ||
      pending.some((open) => open.handle === expected.handle)
    )
      throw new RuntimeError("another worker uses the old session; retained it", "busy", "armada inbox");
  }
  // The replacement may claim before cleanup. Only an exact ended historical
  // generation can authorize touching the old session, never an active reuse.
  if ((allowHistorical && rule === "ended" && (!h || !same(claimRef(h), expected))) || expected.claimedAt === null) {
    if (h && !h.releasedAt && (h.handle === expected.handle || (rule === "active" && expected.claimedAt === null)))
      throw stale(expected.ticket);
    if (!fleet.runtimeReference) throw stale(expected.ticket);
    const ref = await fleet.runtimeReference(expected);
    if (!ref || !same(ref, expected) || (rule === "active" ? !!ref.releasedAt : !ref.releasedAt))
      throw stale(expected.ticket);

    return;
  }
  if (
    !h ||
    runtimeNameOf(h.runtime) !== expected.runtime ||
    !same(claimRef(h), expected) ||
    (expected.coordinator !== undefined && h.coordinator != null && h.coordinator !== expected.coordinator) ||
    (rule === "active" ? !!h.releasedAt : !h.releasedAt)
  )
    throw stale(expected.ticket);
  if (
    expected.coordinator !== undefined &&
    (await fleet.runtimeHandles()).some(
      (open) =>
        open.handle === expected.handle &&
        runtimeNameOf(open.runtime) === expected.runtime &&
        open.coordinator != null &&
        open.coordinator !== expected.coordinator,
    )
  )
    throw stale(expected.ticket);
  if (expected.skipHandedBack) {
    const [open, events] = await Promise.all([fleet.runtimeHandles(), fleet.latestEvents()]);
    if (
      open.some(
        (peer) =>
          peer.handle === expected.handle &&
          runtimeNameOf(peer.runtime) === expected.runtime &&
          events[peer.ticket]?.phase === "ready-to-merge",
      )
    )
      throw new RuntimeError(
        `${expected.ticket}'s worker has handed back; left the runtime untouched`,
        "stale",
        "armada status",
      );
  }
  // Archive can wait for a final turn: ownership must be current at EACH native write,
  // not only in the merge's snapshot. Failure to read ownership leaves the runtime untouched.
  if (rule === "ended" && (await fleet.runtimeHandles()).some((open) => sharesRuntimeWorkspace(expected, open)))
    throw new RuntimeError(
      "another open ticket uses the worker's workspace; left it untouched",
      "busy",
      "armada status",
    );
}
/** A scoped guard: adapters recheck the generation after provenance checks and before EACH native write. */
export async function guarded<T>(
  fleet: Fleet,
  expected: ClaimRef,
  rule: "active" | "ended",
  act: () => Promise<T>,
  /** Replacement cleanup may target an exact ended generation after a newer claim. Merge and stop stay current-only. */
  options: { allowHistorical?: boolean } = {},
): Promise<T> {
  const allowHistorical = options.allowHistorical === true;
  await checkClaim(fleet, expected, rule, allowHistorical);
  return guards.run({ fleet, expected, rule, allowHistorical }, async () => {
    await checkClaim(fleet, expected, rule, allowHistorical);
    return act();
  });
}
/** No adapter mutation is possible outside guarded(), including direct library callers. */
export async function checkedMutation<T>(
  target: ClaimRef,
  verify: () => Promise<unknown>,
  act: () => Promise<T>,
): Promise<T> {
  const guard = guards.getStore();
  if (
    !guard ||
    !same(guard.expected, target) ||
    guard.expected.coordinator !== target.coordinator ||
    guard.expected.skipHandedBack !== target.skipHandedBack
  )
    throw stale(target.ticket);
  await checkClaim(guard.fleet, target, guard.rule, guard.allowHistorical);
  await verify();
  await checkClaim(guard.fleet, target, guard.rule, guard.allowHistorical);
  await leases.getStore()?.();
  return act();
}

/** Native helpers may await additional reads; check again at their actual write boundary. */
export async function recheckMutation(): Promise<void> {
  await leases.getStore()?.();
  const guard = guards.getStore();
  if (guard) await checkClaim(guard.fleet, guard.expected, guard.rule, guard.allowHistorical);
}

/** A historical session cannot authorize archiving a workspace reused by another worker. */
export async function checkWorkspaceEnded(target: ClaimRef): Promise<void> {
  const guard = guards.getStore();
  if (!guard || !same(guard.expected, target)) throw stale(target.ticket);
  const workspace = target.handle.split("/")[0];
  const [handles, launches] = await Promise.all([guard.fleet.runtimeHandles(), guard.fleet.pendingLaunches()]);
  if (
    handles.some(
      (h) => runtimeNameOf(h.runtime) === "conductor" && !h.releasedAt && h.handle.split("/")[0] === workspace,
    ) ||
    launches.some((l) => l.runtime === "conductor" && l.handle?.split("/")[0] === workspace)
  )
    throw new RuntimeError("another worker uses the old workspace; retained it", "busy", "armada inbox");
}

/** Minimal transcript protection pending the dedicated secret-redaction ticket. */
export function redactRuntimeText(text: string, values: readonly string[] = []): string {
  return redactSecrets(text, values);
}

/** Keep herdr's JSON boundary intact, while exposing the common error codes to adapter callers. */
function herdrErrors(adapter: HerdrAdapter): HerdrAdapter {
  return new Proxy(adapter, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        if (!(result instanceof Promise)) return result;
        return result.catch((error: unknown) => {
          if (!(error instanceof UsageError)) throw error;
          const timeout = error instanceof HerdrError && error.code === "timeout";
          const mutating = ["deliver", "launch", "launchPrepared", "cancel", "archive"].includes(String(name));
          const code =
            timeout && mutating
              ? "unknown-outcome"
              : error instanceof HerdrError && error.code === "workspace_not_found"
                ? "not-found"
                : error.message.startsWith("invalid")
                  ? "invalid"
                  : "unavailable";
          const mapped = new RuntimeError(
            "herdr runtime operation failed; inspect its pane before retrying",
            code,
            "use the armada-runtime-herdr guide",
          );
          // The existing CLI classifies herdr UsageError as exit 2; retain that contract.
          mapped.cause = error;
          throw mapped;
        });
      };
    },
  });
}
