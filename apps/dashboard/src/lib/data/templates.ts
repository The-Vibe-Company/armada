import { ControlError, createTemplateControl } from "@/lib/control";
import { mcpUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import type { TemplateItem, TemplateLookups } from "@/lib/templates";
import { listSelectedConnections } from "./connections";
import { listGoldens } from "./goldens";
import { selectedOrganization } from "./selected-org";
import { listSelectedVault } from "./variables";
import { requireViewer } from "./viewer";

/** The template client acting as the signed-in viewer, or null when no Armada server is configured. */
export async function viewerTemplates() {
  const viewer = await requireViewer();
  const url = mcpUrl();
  if (!url || !viewer.token) return null;
  return createTemplateControl({ serverUrl: url, token: viewer.token });
}

export type TemplateList =
  | { state: "ready"; userId: string; items: TemplateItem[] }
  | { state: "no-org" }
  | { state: "not-configured" }
  /** An older server without the template routes: not a failure of this page. */
  | { state: "unsupported"; message: string }
  | { state: "error"; message: string };

/**
 * The selected org's templates the viewer may see, each with its current revision so the list shows its four
 * choices at a glance. The revisions are read in parallel; one that cannot be read leaves its row without details
 * instead of failing the page.
 */
export async function listSelectedTemplates(): Promise<TemplateList> {
  const [viewer, selected] = await Promise.all([requireViewer(), selectedOrganization()]);
  if (!selected) return { state: "no-org" };
  const control = await viewerTemplates();
  if (!control) return { state: "not-configured" };
  const org = selected.org.id;
  try {
    const headers = await control.list(org);
    const items = await Promise.all(
      headers.map(async (header): Promise<TemplateItem> => {
        try {
          const { revision } = await control.get({ org, id: header.id, revision: header.currentRevision });
          return { ...header, revision };
        } catch (error) {
          if (!(error instanceof ControlError)) throw error;
          return { ...header, revision: null };
        }
      }),
    );
    return { state: "ready", userId: viewer.id, items };
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    if (error.status === 404 && error.code === undefined) return { state: "unsupported", message: error.message };
    return { state: "error", message: error.message };
  }
}

/**
 * What templates refer to, as the viewer sees it now: the org's environments, tools and readable variables. A list
 * the server could not give is null, so nothing is judged from it.
 */
export async function templateLookups(): Promise<TemplateLookups> {
  const [goldens, connections, vault] = await Promise.all([
    createClient().then(listGoldens),
    listSelectedConnections(),
    listSelectedVault(),
  ]);
  return {
    goldens: goldens.map((golden) => ({
      id: golden.id,
      name: golden.name,
      provider: golden.provider,
      visibility: golden.visibility,
      ready: Boolean(golden.provider_snapshot_id),
    })),
    connections:
      connections.state === "ready"
        ? connections.connections.map(({ id, name, scope, status }) => ({ id, name, scope, status }))
        : null,
    variables:
      vault.state === "ready"
        ? vault.items
            .filter((item) => item.kind === "variable")
            .map(({ id, name, scope, version, status }) => ({ id, name, scope, version, status }))
        : null,
  };
}
