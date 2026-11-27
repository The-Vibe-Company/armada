import { createControlClient } from "@/lib/control";
import { readViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { syncGitHubStatus } from "@/lib/github";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST() {
  const viewer = await readViewer();
  if (!viewer?.token) return Response.json({ ok: false, error: "Sign in again." }, { status: 401, headers: NO_STORE });
  const serverUrl = mcpUrl();
  if (!serverUrl) {
    return Response.json(
      { ok: false, error: "The Armada server is not configured." },
      { status: 503, headers: NO_STORE },
    );
  }
  const live = await syncGitHubStatus(createControlClient({ serverUrl, token: viewer.token }));
  if (!live || live.status === "unavailable") {
    return Response.json(
      { ok: false, error: "GitHub could not be reached. Try again in a moment." },
      { status: 503, headers: NO_STORE },
    );
  }
  return Response.json({ ok: true, status: live.status, installations: live.installations }, { headers: NO_STORE });
}
