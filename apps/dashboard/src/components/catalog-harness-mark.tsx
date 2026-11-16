import type { Harness } from "@armada/core";
import { TerminalIcon } from "lucide-react";
import { ClaudeAI, OpenAI } from "@/components/provider-marks";

export function CatalogHarnessMark({ harness }: { harness: Harness }) {
  const Mark = harness === "claude" ? ClaudeAI : harness === "codex" ? OpenAI : TerminalIcon;
  return <Mark aria-hidden className="size-9 shrink-0" />;
}
