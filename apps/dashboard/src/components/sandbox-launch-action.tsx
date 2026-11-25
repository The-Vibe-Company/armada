"use client";

import { RocketIcon } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";
import { readLaunchDialogOptions } from "@/app/actions/sandboxes";
import { LaunchDialogContent } from "@/components/launch-surface";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

function loadLaunchStart() {
  return import("@/components/launch-dialog").then((module) => module.DiscoveredLaunchStart);
}

const DiscoveredLaunchStart = dynamic(loadLaunchStart, { ssr: false, loading: LaunchLoading });

function prefetchLaunch() {
  void loadLaunchStart().catch(() => undefined);
}

function LaunchLoading() {
  return (
    <DialogHeader className="p-6">
      <DialogTitle>Launch a sandbox</DialogTitle>
      <DialogDescription>Loading starting points…</DialogDescription>
    </DialogHeader>
  );
}

export function SandboxLaunchAction({ shortcut = false }: { shortcut?: boolean }) {
  const [options, setOptions] = useState<Awaited<ReturnType<typeof readLaunchDialogOptions>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  async function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next || loading) return;
    prefetchLaunch();
    setLoading(true);
    try {
      setOptions(await readLaunchDialogOptions());
    } catch {
      setOptions(null);
    } finally {
      setLoading(false);
    }
  }
  const target = options
    ? (options.targets.find((item) => !item.reason) ??
      options.targets[0] ?? {
        id: "no-starting-point",
        provider: options.build.providers[0] ?? "modal",
        golden: "Unavailable snapshot",
        label: "No starting points",
        group: "Snapshots",
        reason: "No starting points yet. Build a snapshot or register a Docker host before launching.",
        repositories: [],
      })
    : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          aria-label="Launch a sandbox"
          variant={shortcut ? "ghost" : "default"}
          className={cn(shortcut && "w-full justify-start group-data-[state=collapsed]:justify-center")}
          onMouseEnter={prefetchLaunch}
          onFocus={prefetchLaunch}
          onKeyDown={(event) => {
            if (shortcut && event.key.toLowerCase() === "l" && !event.metaKey && !event.ctrlKey && !event.altKey) {
              event.preventDefault();
              void onOpenChange(true);
            }
          }}
        >
          <RocketIcon />
          <span className={cn(shortcut && "group-data-[state=collapsed]:sr-only")}>Launch a sandbox</span>
          {shortcut && (
            <kbd className="ml-auto text-xs text-muted-foreground group-data-[state=collapsed]:hidden">L</kbd>
          )}
        </Button>
      </DialogTrigger>
      <LaunchDialogContent>
        {loading ? (
          <LaunchLoading />
        ) : options && target ? (
          <DiscoveredLaunchStart target={target} options={options} />
        ) : (
          <DialogHeader className="overflow-y-auto p-6 pr-12 text-left">
            <DialogTitle>Launch a sandbox</DialogTitle>
            <DialogDescription>Starting points could not be loaded. Reload Sandboxes to try again.</DialogDescription>
            <Button asChild variant="outline">
              <Link href="/sandboxes">Reload Sandboxes</Link>
            </Button>
          </DialogHeader>
        )}
      </LaunchDialogContent>
    </Dialog>
  );
}
