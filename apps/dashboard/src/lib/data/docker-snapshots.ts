import { type DockerSnapshotRecord, parseDockerSnapshotRecord } from "@armada/core";
import { cache } from "react";
import { ControlError, controlPost } from "@/lib/control";
import { snapshotCurrentVersion } from "@/lib/docker-snapshots";
import { mcpUrl } from "@/lib/env";
import { selectedOrganization } from "./selected-org";
import { requireViewer } from "./viewer";
export const readSelectedDockerSnapshots = cache(
  async (): Promise<
    | { state: "ready"; snapshots: DockerSnapshotRecord[]; currentVersion: string | null }
    | { state: "unavailable"; message: string }
  > => {
    const selected = await selectedOrganization(),
      viewer = await requireViewer(),
      serverUrl = mcpUrl();
    if (!selected || !viewer.token || !serverUrl)
      return { state: "unavailable", message: "The Armada server is not configured." };
    try {
      const body = await controlPost(
        { serverUrl, token: viewer.token },
        "/api/v1/docker/snapshots/list",
        { org: selected.org.id },
        "reading host snapshots",
      );
      if (!Array.isArray(body.snapshots)) throw new ControlError("The server returned an unexpected snapshot list.");
      return {
        state: "ready",
        snapshots: body.snapshots.map(parseDockerSnapshotRecord),
        currentVersion: snapshotCurrentVersion(body.currentVersion),
      };
    } catch (error) {
      return {
        state: "unavailable",
        message: error instanceof ControlError ? error.message : "Host snapshots could not be read.",
      };
    }
  },
);
