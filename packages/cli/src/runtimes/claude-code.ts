import { RuntimeError } from "@armada/core";
import type { RuntimeAdapter } from "./adapter.ts";
export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly name = "claude-code";
  readonly guide = "armada-runtime-claude-code";
  readonly can = {
    launch: false,
    resumeInPlace: false,
    deliver: false,
    keyedDelivery: false,
    observe: false,
    peek: false,
    cancel: false,
    archive: false,
  };
  private refuse(): never {
    throw new RuntimeError(
      "Claude Code subagents use the armada-runtime-claude-code guide",
      "unsupported",
      "use the armada-runtime-claude-code guide",
    );
  }
  parse(): never {
    return this.refuse();
  }
  async preflight(): Promise<never> {
    return this.refuse();
  }
  async launch(): Promise<never> {
    return this.refuse();
  }
  async deliver(): Promise<never> {
    return this.refuse();
  }
  async observe(): Promise<never> {
    return this.refuse();
  }
  async peek(): Promise<never> {
    return this.refuse();
  }
  async cancel(): Promise<never> {
    return this.refuse();
  }
  async archive(): Promise<never> {
    return this.refuse();
  }
}
