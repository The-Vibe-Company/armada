import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  type ArmadaConfig,
  type ClaimRef,
  type Fleet,
  type HerdrProfile,
  RuntimeError,
  type RuntimeHandle,
  type RuntimeName,
  type RuntimeState,
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
  branch: string;
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
export interface OutgoingMessage {
  text: string;
  key: string;
  kind: "answer" | "note" | "login";
}
export interface Delivery {
  via: string;
  messageId: string | null;
  queued: boolean;
}
export interface RuntimeReading {
  state: RuntimeState;
  since: string | null;
  sequence?: number;
  detail: string;
}
export interface Peek extends RuntimeReading {
  link: string | null;
  lastReply: { at: string | null; text: string } | null;
  actions: { at: string | null; kind: "command" | "tool" | "message"; text: string; exit?: number | null }[];
  cursor: string | null;
  truncated: boolean;
}
export interface ArchiveOptions {
  reason: "merged" | "released" | "relaunched";
  whenWorking: "wait" | "cancel" | "refuse";
  waitMs: number;
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
  launch(spec: LaunchSpec): Promise<Launched>;
  deliver(target: ClaimRef, message: OutgoingMessage): Promise<Delivery>;
  observe(target: ClaimRef): Promise<RuntimeReading>;
  peek(target: ClaimRef, options: { actions: number; cursor: string | null }): Promise<Peek>;
  cancel(target: ClaimRef, options: { waitMs: number }): Promise<{ wasWorking: boolean; state: RuntimeState }>;
  archive(target: ClaimRef, options: ArchiveOptions): Promise<Archived>;
}

export function runtimeFor(io: Io, config: ArmadaConfig | undefined, runtime: string): RuntimeAdapter {
  switch (runtimeNameOf(runtime)) {
    case "conductor":
      return new ConductorAdapter(io);
    case "herdr":
      return herdrErrors(new HerdrAdapter(io, config));
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
const guards = new AsyncLocalStorage<{ fleet: Fleet; expected: ClaimRef; rule: "active" | "ended" }>();
function same(a: ClaimRef, b: ClaimRef): boolean {
  return (
    a.ticket === b.ticket &&
    a.runtime === b.runtime &&
    a.handle === b.handle &&
    a.claimedAt === b.claimedAt &&
    a.launchId === b.launchId &&
    a.releasedAt === b.releasedAt
  );
}
async function checkClaim(fleet: Fleet, expected: ClaimRef, rule: "active" | "ended") {
  const h = await fleet.runtimeHandle(expected.ticket);
  if (
    !h ||
    runtimeNameOf(h.runtime) !== expected.runtime ||
    !same(claimRef(h), expected) ||
    (rule === "active" ? !!h.releasedAt : !h.releasedAt)
  )
    throw stale(expected.ticket);
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
): Promise<T> {
  await checkClaim(fleet, expected, rule);
  return guards.run({ fleet, expected, rule }, async () => {
    await checkClaim(fleet, expected, rule);
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
  if (!guard || !same(guard.expected, target)) throw stale(target.ticket);
  await checkClaim(guard.fleet, target, guard.rule);
  await verify();
  await checkClaim(guard.fleet, target, guard.rule);
  return act();
}

/** Native helpers may await additional reads; check again at their actual write boundary. */
export async function recheckMutation(): Promise<void> {
  const guard = guards.getStore();
  if (guard) await checkClaim(guard.fleet, guard.expected, guard.rule);
}

/** Minimal transcript protection pending the dedicated secret-redaction ticket. */
export function redactRuntimeText(text: string): string {
  return text.replace(
    /\b(?:armada_(?:launch|worker|key)_[A-Za-z0-9_-]+|(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)\b/g,
    "[redacted]",
  );
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
