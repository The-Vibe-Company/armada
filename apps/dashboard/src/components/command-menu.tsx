"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { LIVE_FLEET_CHANGE_EVENT, type LiveSandboxes } from "@/lib/live-sandbox-view";

const CommandMenuPalette = dynamic(
  () => import("@/components/command-menu-palette").then((m) => m.CommandMenuPalette),
  {
    ssr: false,
    loading: () => <div className="flex h-12 items-center px-4 text-sm text-muted-foreground">Loading…</div>,
  },
);

/**
 * ⌘K (Ctrl+K elsewhere) from anywhere in the signed-in app: type a few letters of a page, live sandbox, or action,
 * arrows to choose, Enter to go. Mounted once per page; the palette body (and cmdk) loads only when opened.
 */
export function CommandMenu({
  organizationAdmin,
  organizationId = null,
  initialLive = null,
}: {
  organizationAdmin: boolean;
  organizationId?: string | null;
  initialLive?: LiveSandboxes | null;
}) {
  const [open, setOpen] = useState(false);
  const openingFocus = useRef<HTMLElement | null>(null);
  const [fleetUpdate, setFleetUpdate] = useState<{
    initial: LiveSandboxes | null;
    organizationId: string;
    live: LiveSandboxes;
  }>();

  useEffect(() => {
    if (!organizationId) return;
    function onFleetChange(event: Event) {
      const detail = (event as CustomEvent<{ organizationId?: string; live?: LiveSandboxes }>).detail;
      if (detail?.organizationId !== organizationId || !detail.live) return;
      setFleetUpdate({ initial: initialLive, organizationId, live: detail.live });
    }
    window.addEventListener(LIVE_FLEET_CHANGE_EVENT, onFleetChange);
    return () => window.removeEventListener(LIVE_FLEET_CHANGE_EVENT, onFleetChange);
  }, [initialLive, organizationId]);

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        if (!open) openingFocus.current = document.activeElement as HTMLElement | null;
        setOpen((value) => !value);
      }
    }
    function onSearch() {
      openingFocus.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    }
    window.addEventListener("armada:open-search", onSearch);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("armada:open-search", onSearch);
    };
  }, [open]);

  const live =
    fleetUpdate && fleetUpdate.initial === initialLive && fleetUpdate.organizationId === organizationId
      ? fleetUpdate.live
      : initialLive;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        animated={false}
        className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-md"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          openingFocus.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">Search pages, sandboxes, and actions</DialogTitle>
        {open && (
          <CommandMenuPalette
            organizationAdmin={organizationAdmin}
            liveSandboxes={live?.rows ?? []}
            onDone={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
