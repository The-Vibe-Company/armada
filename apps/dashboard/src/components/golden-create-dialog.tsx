"use client";

import { type ReactNode, useState } from "react";
import { CreateDialog } from "@/components/create-dialog";

/**
 * The Environments page's create flow (#898), the dashboard's `CreateDialog` pattern. A build the page tracks in its
 * URL opens the dialog on the first render, so a reload follows it; closing the dialog leaves the build running, and
 * New shows it again (the form reads the job from the URL).
 */
export function GoldenCreateDialog({ initialOpen, children }: { initialOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <CreateDialog
      label="New"
      title="Create a golden"
      description="Repositories, branches and init commands, built once and saved as a snapshot."
      open={open}
      onOpenChange={setOpen}
      className="sm:max-w-3xl"
    >
      {children}
    </CreateDialog>
  );
}
