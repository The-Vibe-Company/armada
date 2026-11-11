import { ControlError, createVaultControl } from "@/lib/control";
import { mcpUrl } from "@/lib/env";
import type { VaultItem } from "@/lib/variables";
import { selectedOrganization } from "./selected-org";
import { requireViewer } from "./viewer";

/** The vault client acting as the signed-in viewer, or null when no Armada server is configured. */
export async function viewerVault() {
  const viewer = await requireViewer();
  const url = mcpUrl();
  if (!url || !viewer.token) return null;
  return createVaultControl({ serverUrl: url, token: viewer.token });
}

export type VaultList =
  | { state: "ready"; userId: string; items: VaultItem[] }
  | { state: "no-org" }
  | { state: "not-configured" }
  /** An older server without the vault routes: not a failure of this page. */
  | { state: "unsupported"; message: string }
  | { state: "error"; message: string };

/** The selected org's variables and secrets the viewer may see: their own personal ones and the org's. */
export async function listSelectedVault(): Promise<VaultList> {
  const [viewer, selected] = await Promise.all([requireViewer(), selectedOrganization()]);
  if (!selected) return { state: "no-org" };
  const vault = await viewerVault();
  if (!vault) return { state: "not-configured" };
  try {
    return { state: "ready", userId: viewer.id, items: await vault.list(selected.org.id) };
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    if (error.status === 404 && error.code === undefined) return { state: "unsupported", message: error.message };
    return { state: "error", message: error.message };
  }
}
