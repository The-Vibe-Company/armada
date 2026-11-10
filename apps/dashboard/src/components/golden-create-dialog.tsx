"use client";

import type { GoldenBuildStatus } from "@armada/core";
import { CheckCircle2Icon, CircleAlertIcon, Loader2Icon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { goldenBuildStatus } from "@/app/actions/goldens";
import { CreateDialog } from "@/components/create-dialog";

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
  return (
    <>
      {!open && <BuildFollower param={`build.create.${orgId}`} />}
      <CreateDialog
        label="New"
        title="Create a golden"
        description="Repositories, branches and init commands, built once and saved as a snapshot."
        open={open}
        onOpenChange={setOpen}
        className="sm:max-w-3xl"
        onCloseAutoFocus={(event) => {
          // Closed by choosing an environment to rebuild instead: the focus stays on its panel, not on New.
          const title = document.getElementById("resource-panel-title");
          if (title && !document.getElementById("resource-panel")?.hidden) {
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

const ACTIVE: readonly GoldenBuildStatus["state"][] = ["queued", "running"];

/**
 * Follows the create build this page tracks while its form is closed: the same bounded status reads the form makes
 * (every 2 s, for 2 minutes at most), never a submit. Its last state shows as one line beside New.
 */
function BuildFollower({ param }: { param: string }) {
  const [status, setStatus] = useState<GoldenBuildStatus | null>(null);
  useEffect(() => {
    const jobId = new URLSearchParams(window.location.search).get(param);
    if (!jobId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 120_000;
    const read = async () => {
      try {
        const next = await goldenBuildStatus(jobId);
        if (!active) return;
        setStatus(next);
        if (ACTIVE.includes(next.state) && Date.now() < deadline) timer = setTimeout(read, 2000);
      } catch {
        // A failed read leaves the last state; New shows the form, which reads the job again.
      }
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [param]);
  if (!status) return null;
  const { icon, text } = followed(status);
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
function followed(status: GoldenBuildStatus): { icon: ReactNode; text: string } {
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
  return { icon: <Loader2Icon aria-hidden className="size-4 animate-spin" />, text: `Building (${status.phase})` };
}
