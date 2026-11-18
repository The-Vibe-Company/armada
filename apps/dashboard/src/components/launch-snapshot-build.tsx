"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { readLaunchDialogOptions } from "@/app/actions/sandboxes";
import { type EmbeddedSnapshotBuild, SnapshotCreateChoice } from "@/components/docker-snapshot-forms";
import { GoldenForm } from "@/components/golden-form";
import type { LaunchStartTarget } from "@/lib/launch-picker";

type Options = Awaited<ReturnType<typeof readLaunchDialogOptions>>;

export const LaunchSnapshotBuild = memo(function LaunchSnapshotBuild({
  repository,
  options,
  onBuilding,
  onSaved,
}: {
  repository: string;
  options: Options;
  onBuilding: (name: string) => void;
  onSaved: (target: LaunchStartTarget, options: Options) => void;
}) {
  const { orgId } = options;
  const [buildInfo, setBuildInfo] = useState<Options["build"]>();
  const [capacityError, setCapacityError] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void readLaunchDialogOptions(true)
      .then((next) => {
        if (!active) return;
        if (next.orgId === orgId) setBuildInfo(next.build);
        else setCapacityError(true);
      })
      .catch(() => {
        if (active) setCapacityError(true);
      });
    return () => {
      active = false;
    };
  }, [orgId]);
  const build = buildInfo ?? options.build;
  const readOptions = useCallback(async () => {
    const next = await readLaunchDialogOptions();
    if (next.orgId !== orgId) throw new Error("Switch to this organization before launching.");
    return next;
  }, [orgId]);
  const readDocker: EmbeddedSnapshotBuild["readDocker"] = useCallback(
    async (id) => {
      const next = await readOptions();
      const target = next.targets.find((item) => item.snapshotId === id);
      if (mounted.current && target && !target.building && !target.failed) {
        const url = new URL(window.location.href);
        url.searchParams.delete(`composer-docker-build-key.${orgId}.${repository}`);
        url.searchParams.delete(`composer-docker-build-id.${orgId}.${repository}`);
        window.history.replaceState(window.history.state, "", url);
        onSaved(target, next);
      }
      return target;
    },
    [onSaved, orgId, readOptions, repository],
  );
  const defaults = { repos: [{ url: repository, branch: "", dir: "" }], init: "" };
  const name =
    repository
      .split("/")[1]
      ?.replace(/^[^a-z0-9]+/, "")
      .slice(0, 80) || "";
  const cloudForms = Object.fromEntries(
    build.providers.map((provider) => [
      provider,
      <GoldenForm
        key={provider}
        mode="create"
        orgId={orgId}
        orgName={build.orgName}
        isAdmin={build.isAdmin}
        providers={build.providers}
        {...(build.capacities ? { capacities: build.capacities } : {})}
        replacements={build.replacements}
        defaults={defaults}
        githubConnected={build.githubConnected}
        embedded={{
          repository,
          name,
          onBuilding,
          onSaved: async (result, actualProvider) => {
            const next = await readOptions();
            const target = next.targets.find(
              (item) => item.provider === actualProvider && item.snapshotRef === result.snapshot,
            );
            if (!target) throw new Error("The snapshot was saved. Open Snapshots to locate it.");
            if (mounted.current) onSaved(target, next);
          },
        }}
      />,
    ]),
  );
  return (
    <section aria-label="Snapshot build" className="mx-5 mb-7 space-y-4 rounded-xl border p-4 sm:mx-8">
      <h3 className="font-semibold">Create a snapshot</h3>
      {!buildInfo && !capacityError ? (
        <p role="status">Loading build placements…</p>
      ) : build.providers.length || build.hosts.length ? (
        <SnapshotCreateChoice
          cloudForms={cloudForms}
          hosts={build.hosts}
          orgId={orgId}
          isAdmin={build.isAdmin}
          canBuild={build.hosts.length > 0}
          githubConnected={build.githubConnected}
          embedded={{ repository, name, onBuilding, readDocker }}
        />
      ) : (
        <p>No build placement is available. Open Snapshots to configure a provider or Docker host.</p>
      )}
    </section>
  );
});
