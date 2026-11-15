import { cache } from "react";
import { ControlError, controlPost } from "@/lib/control";
import { LAUNCH_OPTIONS_ROUTE } from "@/lib/docker-launch";
import { mcpUrl } from "@/lib/env";
import { requireViewer } from "./viewer";

/** Trusted server discovery, shared once per request; old/unavailable servers fail closed. */
export const readLaunchOptions = cache(async (): Promise<unknown> => {
  const viewer = await requireViewer();
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) return null;
  try {
    return await controlPost(
      { serverUrl, token: viewer.token },
      `/api/v1/${LAUNCH_OPTIONS_ROUTE}`,
      {},
      "launch options",
    );
  } catch (error) {
    if (error instanceof ControlError) return null;
    throw error;
  }
});
