import { stripVTControlCharacters } from "node:util";
import { type HerdrHarness, herdrHarnessKind } from "@armada/core";

export interface FirstRunIssue {
  kind: "trust" | "mcp" | "update" | "sign-in" | "model";
  message: string;
}

/** Fixed diagnostics only: pane text can contain paths, sign-in codes and secrets. */
export function firstRunIssue(harness: HerdrHarness, raw: string): FirstRunIssue | null {
  const text = stripVTControlCharacters(raw).replace(/\s+/g, " ");
  const kind = herdrHarnessKind(harness);
  if (kind === "claude") {
    if (
      /Is this a project you created or one you trust\?|Yes, I trust this folder|Do you trust the files in this folder\?/i.test(
        text,
      )
    )
      return { kind: "trust", message: "Claude Code asks to trust this folder" };
    if (/\d+ new MCP servers? found in this project/i.test(text))
      return { kind: "mcp", message: "Claude Code asks about new project MCP servers" };
    if (/Select login method|Log in to use Claude|Sign in to Claude/i.test(text))
      return { kind: "sign-in", message: "Claude Code asks the owner to sign in" };
  }
  if (kind === "codex") {
    if (/not supported when using Codex with a ChatGPT account/i.test(text))
      return { kind: "model", message: "Codex reports the configured model is not supported by this ChatGPT account" };
    if (/Do you trust the contents of this directory\?/i.test(text))
      return { kind: "trust", message: "Codex asks to trust this repository" };
    if (/Update available!/i.test(text) && /Skip until next version/i.test(text))
      return { kind: "update", message: "Codex asks whether to update" };
    if (/Sign in with ChatGPT/i.test(text) && /(?:Use|Provide|Sign in with) an API key/i.test(text))
      return { kind: "sign-in", message: "Codex asks the owner to sign in" };
  }
  if (kind === "opencode" && /Select a provider to connect|Connect a provider/i.test(text))
    return { kind: "sign-in", message: "OpenCode asks the owner to connect a provider" };
  if (/model (?:is )?(?:not found|unavailable)|invalid model|unsupported model/i.test(text))
    return {
      kind: "model",
      message: `${kind === "claude" ? "Claude Code" : kind === "codex" ? "Codex" : "OpenCode"} reports a model problem`,
    };
  return null;
}
