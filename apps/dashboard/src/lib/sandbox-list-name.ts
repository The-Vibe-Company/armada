import type { SandboxListMetadata } from "@armada/core";
import { HARNESS_LABELS } from "./labels.ts";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_TOKEN = /[a-z0-9]{24,}/i;
const CREATED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/** Keep short provider aliases; replace technical noise using only organization-visible metadata, never task text. */
export function sandboxListName(
  row: Pick<SandboxListMetadata, "providerSandboxId" | "displayLabel" | "harness" | "createdAt">,
): string {
  const alias = row.providerSandboxId ?? row.displayLabel;
  if (alias && alias.length <= 48 && !UUID.test(alias) && !LONG_TOKEN.test(alias)) return alias;
  const agent = `${HARNESS_LABELS[row.harness] ?? "Agent"} sandbox`;
  const created = Date.parse(row.createdAt);
  return Number.isFinite(created) ? `${agent} · ${CREATED.format(created)} UTC` : agent;
}
