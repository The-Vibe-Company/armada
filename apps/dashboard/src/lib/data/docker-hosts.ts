import { validDockerHostResources } from "@armada/core";
import { cache } from "react";
import { ControlError, controlPost } from "@/lib/control";
import {
  DOCKER_HOST_ROUTES,
  type DockerHostList,
  type HostRegistration,
  isRouteAbsent,
  parseDockerHostList,
  parseHostRegistration,
} from "@/lib/docker-hosts";
import { type DockerLaunchOption, dockerLaunchOption, LAUNCH_OPTIONS_ROUTE } from "@/lib/docker-launch";
import { mcpUrl } from "@/lib/env";
import { selectedOrganization } from "./selected-org";
import { requireViewer } from "./viewer";

const FEATURE = "Docker hosts";

/**
 * The Docker host control client, acting as the signed-in viewer from the dashboard's server, or null when no Armada
 * server is configured. The server refuses these routes from a browser (any `Origin`), so they are never proxied.
 * A registration token is returned once to the caller and never logged or kept here.
 */
export async function viewerDockerHosts() {
  const viewer = await requireViewer();
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) return null;
  const options = { serverUrl, token: viewer.token };
  const post = (route: string, body: object) => controlPost(options, `/api/v1/${route}`, body, FEATURE);
  return {
    async list(org: string): Promise<DockerHostList> {
      const list = parseDockerHostList(await post(DOCKER_HOST_ROUTES.list, { org }));
      if (!list) throw new ControlError("The Armada server sent an unexpected host list.");
      if (list.skipped > 0) console.error(`Docker host list: ${list.skipped} host(s) left out, off the contract.`);
      return list;
    },
    /** The name is sent only when given, so a server without host naming still answers an unnamed request. */
    async register(org: string, name: string | null): Promise<HostRegistration> {
      const answer = await post(DOCKER_HOST_ROUTES.registerToken, name === null ? { org } : { org, name });
      const registration = parseHostRegistration(answer);
      if (!registration)
        throw new ControlError(
          "The Armada server did not answer with an install command. It may need an update to add hosts with one command.",
        );
      return registration;
    },
    async limits(
      org: string,
      hostId: string,
      patch: { auto: true } | { cpus?: number; memoryBytes?: number; maxSandboxes?: number },
    ): Promise<void> {
      const answer = await post(DOCKER_HOST_ROUTES.limits, { org, hostId, ...patch });
      if (!validDockerHostResources(answer.resources))
        throw new ControlError("The Armada server did not confirm the host limits.");
    },
    async revoke(org: string, hostId: string): Promise<void> {
      const answer = await post(DOCKER_HOST_ROUTES.revoke, { org, hostId });
      if (answer.revoked !== true) throw new ControlError("The Armada server did not confirm the revocation.");
    },
  };
}

export type DockerHostsState =
  | { state: "ready"; list: DockerHostList }
  | { state: "disabled" }
  | { state: "error"; message: string };

/**
 * The selected organization's Docker hosts, or why there are none to show, read once per request: the navigation and
 * the Hosts page share it. Without an organization, an Armada server or the server's host list, Docker hosts are
 * "disabled" here (the list is the opt-in signal).
 */
export const readSelectedDockerHosts = cache(async (): Promise<DockerHostsState> => {
  const selected = await selectedOrganization();
  if (!selected) return { state: "disabled" };
  const control = await viewerDockerHosts();
  if (!control) return { state: "disabled" };
  try {
    return { state: "ready", list: await control.list(selected.org.id) };
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    if (isRouteAbsent(error)) return { state: "disabled" };
    return { state: "error", message: error.message };
  }
});

/** The navigation's patience: past this, its Hosts entry stays hidden instead of holding a refresh. */
const NAV_DEADLINE_MS = 2_000;

/**
 * Whether the navigation shows Hosts: only when the list was read. Disabled, failing or slow hides the entry (a direct
 * visit to the page still says what went wrong). The shell does not wait for it: only that one entry does.
 */
export async function dockerHostsEnabled(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), NAV_DEADLINE_MS);
  });
  try {
    return await Promise.race([readSelectedDockerHosts().then((hosts) => hosts.state === "ready"), deadline]);
  } catch {
    // Streamed to the client navigation: an unexpected failure hides the entry instead of breaking the menu.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The selected organization's host list for a Docker sandbox page's host name (#1526), or null when it is not read
 * within the navigation's patience: the page then names the host by its short id instead of waiting.
 */
export async function hostListForPage(): Promise<DockerHostList | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), NAV_DEADLINE_MS);
  });
  try {
    return await Promise.race([
      readSelectedDockerHosts().then((hosts) => (hosts.state === "ready" ? hosts.list : null)),
      deadline,
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Docker entry of the server's launch options, once per request, or null when it cannot be read or has none
 * (an older server, Docker not enabled): the launch then stays unavailable, never a dead button.
 */
export const readDockerLaunchOption = cache(async (): Promise<DockerLaunchOption | null> => {
  const viewer = await requireViewer();
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) return null;
  try {
    return dockerLaunchOption(
      await controlPost({ serverUrl, token: viewer.token }, `/api/v1/${LAUNCH_OPTIONS_ROUTE}`, {}, "launch options"),
    );
  } catch (error) {
    if (error instanceof ControlError) return null;
    throw error;
  }
});
