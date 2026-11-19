import { Suspense } from "react";
import { DockerLimitList } from "@/components/launch-composer";
import { readDockerLaunchOption, readSelectedDockerHosts } from "@/lib/data/docker-hosts";
import { dockerUnavailable } from "@/lib/docker-launch";

async function DiscoveredLimits() {
  const hosts = await readSelectedDockerHosts().catch(() => null);
  if (hosts?.state !== "ready" || !hosts.list.hosts.some((host) => host.state !== "revoked")) return null;
  const option = await readDockerLaunchOption().catch(() => null);
  return option ? <DockerLimitList unavailable={dockerUnavailable(option)} /> : null;
}

/** The existing server discovery streams separately from the settings and launch trigger. */
export function DockerLaunchLimitList() {
  return (
    <Suspense fallback={null}>
      <DiscoveredLimits />
    </Suspense>
  );
}
