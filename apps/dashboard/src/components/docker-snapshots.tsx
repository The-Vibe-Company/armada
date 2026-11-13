"use client";

import { useEffect, useMemo, useState } from "react";
import { listDockerSnapshots } from "@/app/actions/docker-hosts";
import { useResourceSelected } from "@/components/resource-browser";
import { PanelSection } from "@/components/state-cell";
import { Button } from "@/components/ui/button";
import type { DockerSnapshotsResult } from "@/lib/docker-snapshots";

/** Hidden host panels stay mounted; never fetch private data for every host on page load. */
export function DockerSnapshots({ orgId, hostId }: { orgId: string; hostId: string }) {
  const selected = useResourceSelected(hostId);
  const [result, setResult] = useState<DockerSnapshotsResult | null>(null);
  const [refresh, setRefresh] = useState(0);
  const request = useMemo(() => ({ orgId, hostId, refresh }), [orgId, hostId, refresh]);
  useEffect(() => {
    setResult(null);
    if (!selected) return;
    let current = true;
    listDockerSnapshots(request.orgId, request.hostId)
      .then((value) => {
        if (current) setResult(value);
      })
      .catch(() => {
        if (current) setResult({ state: "unavailable" });
      });
    return () => {
      current = false;
    };
  }, [selected, request]);

  return (
    <PanelSection title="Your snapshots" data-host-snapshots={hostId}>
      <div aria-live="polite" aria-busy={selected && result === null}>
        {result === null ? (
          <p className="text-sm text-muted-foreground">Loading snapshots…</p>
        ) : result.state === "unavailable" ? (
          <p role="status" className="text-sm text-muted-foreground">
            Snapshots could not be loaded. Try again.
          </p>
        ) : result.snapshots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No saved snapshots on this host.</p>
        ) : (
          <ul className="divide-y">
            {result.snapshots.map((snapshot) => (
              <li key={snapshot.id} className="flex min-w-0 flex-col gap-1 py-2 first:pt-0 last:pb-0">
                <span className="break-words text-sm font-medium">{snapshot.name}</span>
                <span className="text-xs text-muted-foreground">Built on Armada {snapshot.builtOnVersion}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Private to you. Saved metadata does not confirm that the snapshot’s files are still on this host.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!selected || result === null}
        onClick={() => setRefresh((value) => value + 1)}
      >
        {result?.state === "unavailable" ? "Try again" : "Refresh snapshots"}
      </Button>
    </PanelSection>
  );
}
