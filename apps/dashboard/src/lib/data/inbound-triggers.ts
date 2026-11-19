import { ControlError } from "@/lib/control";
import { selectedOrganization } from "@/lib/data/selected-org";
import { viewerTemplates } from "@/lib/data/templates";
import { requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { createInboundTriggerControl } from "@/lib/inbound-triggers";

export async function viewerInboundTriggers(org: string) {
  const selected = await selectedOrganization();
  if (selected?.org.id !== org || selected.role !== "admin") return null;
  const { token } = await requireViewer();
  const serverUrl = mcpUrl();
  return serverUrl && token ? createInboundTriggerControl({ serverUrl, token }, org) : null;
}

export async function inboundTriggerTemplates(org: string) {
  const control = await viewerTemplates();
  if (!control) return null;
  try {
    return (await control.list(org)).map(({ id, name, scope }) => ({ id, name, scope }));
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return null;
  }
}
