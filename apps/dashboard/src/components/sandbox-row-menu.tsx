"use client";
import type { SandboxPlacementProviderId, SandboxStatus } from "@armada/core";
import { capabilities } from "@armada/core/machine-capabilities";
import { CopyIcon, ExternalLinkIcon, Loader2Icon, MoreHorizontalIcon, SquareIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useCallback, useState } from "react";
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
import type { ActionResult } from "@/lib/action";
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
  const [dialog, setDialog] = useState<{ open: boolean; kind: "stop" | "delete" }>({ open: false, kind: "stop" });

  const caps = capabilities(provider);
  const canStop = canManage && CAN_STOP.includes(status);
  const canDelete = canManage && caps.launchSource === "host" && CAN_DELETE.includes(status);

  const runAction = useCallback(
    async (previous: ActionResult | null, data: FormData) => {
      const kind = data.get("kind") === "delete" ? "delete" : "stop";
      try {
        const result = await clientMutation(() =>
          kind === "stop" ? stopSandbox(previous, data) : deleteSandbox(previous, data),
        );
        toast(toastFromResult(result, kind === "stop" ? "Stop request not confirmed" : "Delete request not confirmed"));
        setDialog((cur) => ({ ...cur, open: false }));
        if (result.ok) router.refresh();
        return result;
      } catch (error) {
        setDialog((cur) => ({ ...cur, open: false }));
        throw error;
      }
    },
    [router, toast],
  );
  const [, submitAction, pending] = useActionState(runAction, null);

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
            <DropdownMenuItem variant="destructive" onSelect={() => setDialog({ open: true, kind: "stop" })}>
              <SquareIcon />
              Stop sandbox…
            </DropdownMenuItem>
          )}
          {canDelete && (
            <DropdownMenuItem variant="destructive" onSelect={() => setDialog({ open: true, kind: "delete" })}>
              <Trash2Icon />
              Delete sandbox…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog
        open={dialog.open}
        onOpenChange={(open) => {
          if (!open && !pending) setDialog((cur) => ({ ...cur, open: false }));
        }}
      >
        <AlertDialogContent
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dialog.kind === "delete" ? "Delete this sandbox?" : "Stop this sandbox?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dialog.kind === "delete"
                ? "Its container and workspace are removed from the host for good. This cannot be undone."
                : caps.stopRetention === "container"
                  ? "The container stops and its workspace stays on the host."
                  : "The machine is removed. Its disk and conversations are kept, so you can resume later."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <form action={submitAction} className="w-full sm:w-auto">
              <input type="hidden" name="sandbox" value={id} />
              <input type="hidden" name="kind" value={dialog.kind} />
              {dialog.kind === "delete" && <input type="hidden" name="stay" value="1" />}
              <Button type="submit" variant="destructive" disabled={pending} className="w-full sm:w-auto">
                {pending && <Loader2Icon aria-hidden="true" className="motion-safe:animate-spin" />}
                {dialog.kind === "delete" ? "Delete sandbox" : "Stop sandbox"}
              </Button>
            </form>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
