"use client";

import type { GoldenBuildStatus } from "@armada/core";
import { CheckCircle2Icon, CircleAlertIcon, Loader2Icon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { goldenBuildStatus } from "@/app/actions/goldens";
import { CreateDialog } from "@/components/create-dialog";
import { visibleResourcePanelTitle } from "@/components/resource-browser";
import { ITEM_PARAM } from "@/lib/resource-list";

/**
 * The Environments page's create flow (#898), the dashboard's `CreateDialog` pattern. A build the page tracks in its
 * URL opens the dialog on the first render, so a reload follows it. Closing the dialog leaves the build running: a
 * line beside New follows it until it ends (its success refreshes the list), and New shows the form on it again.
 */
export function GoldenCreateDialog({
  orgId,
  initialOpen,
  children,
}: {
  orgId: string;
  initialOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  // The row selected when the dialog opened: a different one at close means "Rebuild X" handed off to its panel.
  const itemAtOpen = useRef<string | null>(null);
  const param = `build.create.${orgId}`;
  return (
    <>
      {!open && <BuildFollower key={param} param={param} />}
      <CreateDialog
        label="New"
        title="Create a golden"
        description="Repositories, branches and init commands, built once and saved as a snapshot."
        open={open}
        onOpenChange={(next) => {
          if (next) itemAtOpen.current = currentItem();
          setOpen(next);
        }}
        className="sm:max-w-3xl"
        onCloseAutoFocus={(event) => {
          // Closed by choosing an environment to rebuild instead: the focus stays on its panel, not on New.
          const title = visibleResourcePanelTitle();
          const item = currentItem();
          if (title && item !== null && item !== itemAtOpen.current) {
            event.preventDefault();
            title.focus();
          }
        }}
      >
        {children}
      </CreateDialog>
    </>
  );
}

function currentItem(): string | null {
  return new URLSearchParams(window.location.search).get(ITEM_PARAM);
}

const ACTIVE: readonly GoldenBuildStatus["state"][] = ["queued", "running"];

/**
 * Follows the create build this page tracks while its form is closed: the same bounded status reads the form makes
 * (every 2 s, for 2 minutes at most), never a submit. Its last state shows as one line beside New.
 */
function BuildFollower({ param }: { param: string }) {
  const [status, setStatus] = useState<GoldenBuildStatus | null>(null);
  // Reads stopped (the 2-minute bound or a failed read) while the build was still running.
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 120_000;
    const read = async () => {
      const params = new URLSearchParams(window.location.search);
      const jobId = params.get(param);
      if (!jobId) {
        // Closed while the admission was in flight: its job id lands in the URL when the answer comes back.
        if (params.has(`build-key.${param.slice("build.".length)}`) && Date.now() < deadline)
          timer = setTimeout(read, 2000);
        return;
      }
      try {
        const next = await goldenBuildStatus(jobId);
        if (!active) return;
        setStatus(next);
        if (!ACTIVE.includes(next.state)) return;
        if (Date.now() < deadline) timer = setTimeout(read, 2000);
        else setStopped(true);
      } catch {
        if (active) setStopped(true);
      }
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [param]);
  if (!status) return null;
  const { icon, text } = followed(status, stopped);
  return (
    <p
      role="status"
      data-create-build={status.state}
      className="flex items-center gap-1.5 text-sm text-muted-foreground"
    >
      {icon}
      {text}
    </p>
  );
}

/** The line beside New for the build's last read state. */
function followed(status: GoldenBuildStatus, stopped: boolean): { icon: ReactNode; text: string } {
  if (status.state === "succeeded")
    return {
      icon: <CheckCircle2Icon aria-hidden className="size-4 text-success" />,
      text: `Built ${status.result?.name ?? "the golden"}`,
    };
  if (status.state === "failed" || status.state === "recovery_required")
    return {
      icon: <CircleAlertIcon aria-hidden className="size-4 text-destructive" />,
      text: "Build failed: open New for details",
    };
  if (stopped)
    return { icon: <CircleAlertIcon aria-hidden className="size-4" />, text: "Still building: open New to check" };
  return { icon: <Loader2Icon aria-hidden className="size-4 animate-spin" />, text: `Building (${status.phase})` };
}
