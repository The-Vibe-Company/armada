"use client";

import { useCallback, useState } from "react";
import { CreateDialog } from "@/components/create-dialog";
import { InviteForm } from "@/components/invitations";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action";

export function InviteMemberDialog({
  org,
  action,
}: {
  org: string;
  action: (previous: ActionResult | null, data: FormData) => Promise<ActionResult>;
}) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const invite = useCallback(
    async (previous: ActionResult | null, data: FormData) => {
      const result = await action(previous, data);
      if (result.ok) {
        toast({ tone: "success", title: result.message });
        setOpen(false);
      }
      return result;
    },
    [action, toast],
  );
  return (
    <CreateDialog
      label="Invite a member"
      title="Invite a member"
      description="Send an invitation to join this organization."
      open={open}
      onOpenChange={setOpen}
    >
      <InviteForm org={org} action={invite} />
    </CreateDialog>
  );
}
