import type { JsonObject } from "@earendil-works/pi-durable";

export type MergeFailureCode =
  | "forge_unreachable"
  | "tracker_write_failed"
  | "head_moved"
  | "checks_pending"
  | "checks_red"
  | "review_threads_open"
  | "base_conflict"
  | "hold_open"
  | "lease_held"
  | "local_gate_failed"
  | "rules_changed"
  | "worker_changed"
  | "merge_refused";

/** Provider errors can contain response bodies or credentials. Only a bounded first line crosses the tool boundary. */
export function refusalLine(value: unknown, fallback = "Unknown merge error"): string {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : fallback;
  return (
    text
      .split(/[\r\n\u2028\u2029]/, 1)[0]
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal escape sequences from provider errors.
      ?.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: provider control characters cannot cross into the room.
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .replace(
        /\b(?:Bearer\s+\S+|eyJ[\w.-]{8,}|(?:gh[pousr]_|github_pat_|sk-|lin_api_|armada_(?:launch|worker)_)[\w.-]+)/gi,
        "[redacted]",
      )
      .replace(/\b(authorization|token|api[_-]?key|password|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/\s*(?:<html\b|<!doctype\b|response body\s*:|body\s*:).*$/i, "")
      .replace(/armada\.toml/g, "project rules")
      .replace(/armada\s+/g, "coordinator tools ")
      .trim()
      .slice(0, 500) || fallback
  );
}

/** One shape for all coordinator refusals; message remains for older room clients. */
export function refuse(code: string, reason: string, next = "fleet.status", extra: JsonObject = {}): JsonObject {
  const safe = refusalLine(reason);
  return { ...extra, ok: false, code, reason: safe, message: safe, next: refusalLine(next) };
}

/** Preserve a known refusal through asynchronous provider and generation guards. */
export class MergeFailure extends Error {
  readonly code: MergeFailureCode;
  readonly next: string;
  constructor(code: MergeFailureCode, reason: string, next: string) {
    super(reason);
    this.code = code;
    this.next = next;
  }
  result() {
    return refuse(this.code, this.message, this.next);
  }
}
