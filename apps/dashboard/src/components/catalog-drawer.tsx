"use client";

import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";

/** Catalog details retain the page behind a full-height, accessible drawer. */
export function CatalogDrawer({
  open,
  onOpenChange,
  title,
  subtitle,
  mark,
  children,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: ReactNode;
  mark?: ReactNode;
  children: ReactNode;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[460px] flex-col border-l bg-card shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-right motion-reduce:animate-none"
        >
          <header className="flex items-center gap-3 border-b px-5 py-[18px]">
            {mark}
            <div className="min-w-0 flex-1 space-y-1">
              <DialogPrimitive.Title className="truncate text-base font-semibold">{title}</DialogPrimitive.Title>
              {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
            </div>
            <DialogPrimitive.Close
              aria-label="Close details"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            >
              <XIcon className="size-4" />
            </DialogPrimitive.Close>
          </header>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
