"use client";

import { RocketIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { readLaunchDialogOptions } from "@/app/actions/sandboxes";
import { LaunchStart } from "@/components/launch-dialog";
import { LaunchDialogContent } from "@/components/launch-surface";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function SandboxLaunchAction({ shortcut = false }: { shortcut?: boolean }) {
  const [options, setOptions] = useState<Awaited<ReturnType<typeof readLaunchDialogOptions>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  async function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next || loading) return;
    setLoading(true);
    try {
      setOptions(await readLaunchDialogOptions());
    } catch {
      setOptions(null);
    } finally {
      setLoading(false);
    }
  }
  const target = options?.targets.find((item) => !item.reason);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          onKeyDown={(event) => {
            if (shortcut && event.key.toLowerCase() === "l" && !event.metaKey && !event.ctrlKey && !event.altKey) {
              event.preventDefault();
              void onOpenChange(true);
            }
          }}
        >
          <RocketIcon /> Launch a sandbox
          {shortcut && <kbd className="ml-auto text-xs text-muted-foreground">L</kbd>}
        </Button>
      </DialogTrigger>
      <LaunchDialogContent>
        {loading ? (
          <DialogHeader className="p-6">
            <DialogTitle>Launch a sandbox</DialogTitle>
            <DialogDescription>Loading starting points…</DialogDescription>
          </DialogHeader>
        ) : options && target ? (
          target.hostId ? (
            <LaunchStart
              initialOptions={options}
              orgId={options.orgId}
              hostId={target.hostId}
              hostName={target.label.replace(/^Empty machine · /, "")}
              accounts={options.accounts}
              unavailable={[]}
              harnesses={target.harnesses ?? []}
              initialHarness={target.initialHarness ?? "codex"}
            />
          ) : (
            <LaunchStart
              initialOptions={options}
              orgId={options.orgId}
              golden={target.golden}
              provider={target.provider}
              {...(target.snapshotId ? { snapshotId: target.snapshotId } : {})}
              repositories={target.repositories}
              {...(target.sizing ? { sizing: target.sizing } : {})}
              accounts={options.accounts}
              catalog={options.catalog}
              connections={options.connections}
              boatOpenCodeAvailable={options.boatOpenCodeAvailable}
            />
          )
        ) : (
          <DialogHeader className="overflow-y-auto p-6 pr-12 text-left">
            <DialogTitle>Launch a sandbox</DialogTitle>
            <DialogDescription>
              {options
                ? options.targets.length > 0
                  ? "Your starting points need attention before launching."
                  : "No starting points yet. Build a snapshot or connect your server before launching."
                : "Starting points could not be loaded. Reload Sandboxes to try again."}
            </DialogDescription>
            {options && options.targets.length > 0 && (
              <ul className="space-y-3 text-sm">
                {options.targets.map((item) => (
                  <li key={item.id}>
                    <p className="font-medium">{item.label}</p>
                    <p className="text-muted-foreground">{item.reason}</p>
                    <Link className="underline underline-offset-4" href={item.hostId ? "/hosts" : "/snapshots"}>
                      {item.hostId ? "Open Hosts" : "Open Snapshots"}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <Button asChild variant="outline">
              <Link href={options ? "/snapshots" : "/sandboxes"}>
                {options ? "Open Snapshots" : "Reload Sandboxes"}
              </Link>
            </Button>
          </DialogHeader>
        )}
      </LaunchDialogContent>
    </Dialog>
  );
}
