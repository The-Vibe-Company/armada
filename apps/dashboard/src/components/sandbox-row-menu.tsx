"use client";
import type { SandboxPlacementProviderId, SandboxStatus } from "@armada/core";
import { capabilities } from "@armada/core/machine-capabilities";
import { CopyIcon, ExternalLinkIcon, Loader2Icon, MoreHorizontalIcon, SquareIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteSandbox, stopSandbox } from "@/app/actions/sandboxes";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { clientMutation } from "@/lib/client-mutation";
import { toastFromResult } from "@/lib/toast";

const CAN_STOP: readonly SandboxStatus[] = ["starting", "ready", "running"];
const CAN_DELETE: readonly SandboxStatus[] = ["stopped", "failed"];

export function SandboxRowMenu({
  id,
  name,
  canOpen,
  canManage,
  status,
  provider,
}: {
  id: string;
  name: string;
  canOpen: boolean;
  canManage: boolean;
  status: SandboxStatus;
  provider: SandboxPlacementProviderId;
}) {
  const router = useRouter();
  const toast = useToast();
  const [confirm, setConfirm] = useState<"stop" | "delete" | null>(null);
  const [pending, startTransition] = useTransition();

  const caps = capabilities(provider);
  const canStop = canManage && CAN_STOP.includes(status);
  const canDelete = canManage && caps.launchSource === "host" && CAN_DELETE.includes(status);

  function submitConfirm() {
    if (!confirm || pending) return;
    const actionKind = confirm;
    startTransition(async () => {
      const data = new FormData();
      data.set("sandbox", id);
      const result = await clientMutation(() =>
        actionKind === "stop" ? stopSandbox(null, data) : deleteSandbox(null, data),
      );
      toast(
        toastFromResult(result, actionKind === "stop" ? "Stop request not confirmed" : "Delete request not confirmed"),
      );
      setConfirm(null);
      if (result.ok) router.refresh();
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${name}`}
            className="size-8 transition-opacity duration-120 ease-(--ease-out) motion-reduce:transition-none focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:opacity-65 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100"
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canOpen && (
            <DropdownMenuItem asChild>
              <Link href={`/sandboxes/${id}`}>
                <ExternalLinkIcon />
                Open sandbox
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => {
              void (navigator.clipboard?.writeText(id) ?? Promise.reject(new Error("Clipboard unavailable")))
                .then(() => toast({ title: "Sandbox ID copied", tone: "success" }))
                .catch(() => toast({ title: "Could not copy ID", tone: "destructive" }));
            }}
          >
            <CopyIcon />
            Copy ID
          </DropdownMenuItem>
          {(canStop || canDelete) && <DropdownMenuSeparator />}
          {canStop && (
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm("stop")}>
              <SquareIcon />
              Stop sandbox…
            </DropdownMenuItem>
          )}
          {canDelete && (
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm("delete")}>
              <Trash2Icon />
              Delete sandbox…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "delete" ? "Delete this sandbox?" : "Stop this sandbox?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "delete"
                ? "Its container and workspace are removed from the host for good. This cannot be undone."
                : caps.stopRetention === "container"
                  ? "The container stops and its workspace stays on the host."
                  : "The machine is removed. Its disk and conversations are kept, so you can resume later."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={pending} onClick={submitConfirm}>
              {pending && <Loader2Icon className="animate-spin" />}
              {confirm === "delete" ? "Delete sandbox" : "Stop sandbox"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
