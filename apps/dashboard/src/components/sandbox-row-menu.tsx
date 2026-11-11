"use client";
import { CopyIcon, ExternalLinkIcon, MoreHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";

export function SandboxRowMenu({ id, name, canOpen }: { id: string; name: string; canOpen: boolean }) {
  const toast = useToast();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${name}`}>
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
