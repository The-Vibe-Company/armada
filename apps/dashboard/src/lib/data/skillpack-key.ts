import { ControlError, controlPost } from "@/lib/control";
import { mcpUrl } from "@/lib/env";
import {
  SKILLPACK_KIND,
  SKILLPACK_ROUTES,
  type SkillpackKeys,
  type SkillpackScope,
  skillpackKeysFromList,
} from "@/lib/skillpack-key";
import { selectedOrganization } from "./selected-org";
import { requireViewer } from "./viewer";

const FEATURE = "the Skillpack key";

/**
 * The Skillpack key's control client, acting as the signed-in viewer, or null when no Armada server is configured.
 * A key travels once, in a request body; no answer carries it back.
 */
export async function viewerSkillpackKey() {
  const viewer = await requireViewer();
  const url = mcpUrl();
  if (!url || !viewer.token) return null;
  const options = { serverUrl: url, token: viewer.token };
  const post = (route: string, body: object) => controlPost(options, `/api/v1/${route}`, body, FEATURE);
  return {
    list: async (org: string) => skillpackKeysFromList(await post(SKILLPACK_ROUTES.list, { org }), org, Date.now()),
    set: (body: { scope: SkillpackScope; org: string; value: string }) =>
      post(SKILLPACK_ROUTES.set, { ...body, kind: SKILLPACK_KIND }).then(() => undefined),
    remove: (body: { scope: SkillpackScope; org: string }) =>
      post(SKILLPACK_ROUTES.remove, { ...body, kind: SKILLPACK_KIND }).then(() => undefined),
  };
}

export type SkillpackKeyState =
  | { state: "ready"; keys: SkillpackKeys }
  | { state: "no-org" }
  | { state: "not-configured" }
  | { state: "error"; message: string };

/** The viewer's own key and the selected organization's, as stored: dates and state only. */
export async function readSelectedSkillpackKeys(): Promise<SkillpackKeyState> {
  const selected = await selectedOrganization();
  if (!selected) return { state: "no-org" };
  const control = await viewerSkillpackKey();
  if (!control) return { state: "not-configured" };
  try {
    return { state: "ready", keys: await control.list(selected.org.id) };
  } catch (error) {
    if (error instanceof ControlError) return { state: "error", message: error.message };
    throw error;
  }
}
