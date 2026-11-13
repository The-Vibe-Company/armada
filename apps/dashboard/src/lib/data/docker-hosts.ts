import { cache } from "react";
import { ControlError, controlPost } from "@/lib/control";
import {
  DOCKER_HOST_ROUTES,
  type DockerHostList,
  type HostRegistration,
  parseDockerHostList,
  parseHostRegistration,
} from "@/lib/docker-hosts";
import { mcpUrl } from "@/lib/env";
import { selectedOrganization } from "./selected-org";
import { requireViewer } from "./viewer";

const FEATURE = "Docker hosts";

/** The navigation asks once per render and must not hold the shell: a slow answer reads as "not enabled". */
const ENABLED_TIMEOUT_MS = 3_000;

/**
 * The Docker host control client, acting as the signed-in viewer from the dashboard's server, or null when no Armada
 * server is configured. The server refuses these routes from a browser (any `Origin`), so they are never proxied.
 * A registration token is returned once to the caller and never logged or kept here.
 */
export async function viewerDockerHosts(timeoutMs?: number) {
  const viewer = await requireViewer();
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) return null;
  const options = { serverUrl, token: viewer.token, ...(timeoutMs ? { timeoutMs } : {}) };
  const post = (route: string, body: object) => controlPost(options, `/api/v1/${route}`, body, FEATURE);
  return {
    serverUrl,
    async list(org: string): Promise<DockerHostList> {
      const list = parseDockerHostList(await post(DOCKER_HOST_ROUTES.list, { org }));
      if (!list) throw new ControlError("The Armada server sent an unexpected host list.");
      return list;
    },
    async register(org: string): Promise<HostRegistration> {
      const registration = parseHostRegistration(await post(DOCKER_HOST_ROUTES.registerToken, { org }));
      if (!registration) throw new ControlError("The Armada server sent an unexpected registration.");
      return registration;
    },
    async revoke(org: string, hostId: string): Promise<void> {
      const answer = await post(DOCKER_HOST_ROUTES.revoke, { org, hostId });
      if (answer.revoked !== true) throw new ControlError("The Armada server did not confirm the revocation.");
    },
  };
}

/** A route the server does not mount answers 404 without a code: Docker hosts are not enabled there. */
function isNotEnabled(error: ControlError): boolean {
  return (error.status === 404 || error.status === 405) && error.code === undefined;
}

export type DockerHostsState =
  | { state: "ready"; list: DockerHostList }
  | { state: "disabled" }
  | { state: "no-org" }
  | { state: "error"; message: string };

/** The selected organization's Docker hosts, or why there are none to show. */
export async function readSelectedDockerHosts(): Promise<DockerHostsState> {
  const selected = await selectedOrganization();
  if (!selected) return { state: "no-org" };
  const control = await viewerDockerHosts();
  if (!control) return { state: "disabled" };
  try {
    return { state: "ready", list: await control.list(selected.org.id) };
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    if (isNotEnabled(error)) return { state: "disabled" };
    return { state: "error", message: error.message };
  }
}

/**
 * Whether the navigation shows Hosts: the server answers the host list for the selected organization. Any failure
 * hides the entry; the page itself says what went wrong when visited directly.
 */
export const dockerHostsEnabled = cache(async (): Promise<boolean> => {
  const selected = await selectedOrganization();
  if (!selected) return false;
  const control = await viewerDockerHosts(ENABLED_TIMEOUT_MS);
  if (!control) return false;
  try {
    await control.list(selected.org.id);
    return true;
  } catch (error) {
    if (error instanceof ControlError) return false;
    throw error;
  }
});
