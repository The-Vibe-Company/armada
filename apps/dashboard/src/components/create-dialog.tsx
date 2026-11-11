"use client";

import { PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * The create/add pattern of a dashboard page (#896): a header button that opens one short, focused form in a
 * centred dialog over the list, never a panel beside it that squeezes the list. Things the page already lists
 * (a catalog service, an existing item) are acted on from the page itself, not repeated in the dialog. Pass it as
 * `ResourceBrowser`'s `actions`. The form stays short enough to read without scrolling on a laptop and marks any
 * choice that cannot be changed later; on a phone the dialog scrolls inside itself.
 *
 * Uncontrolled by default, so every opening starts a clean form; pass `open` and `onOpenChange` to close it on a
 * success or to open it from elsewhere. Focus returns to the button when it closes.
 */
export function CreateDialog({
  label,
  title,
  description,
  children,
  open,
  onOpenChange,
  className,
  triggerAttrs,
  onCloseAutoFocus,
}: {
  /** The header button's text, beside a plus. */
  label: string;
  /** The dialog's accessible name. */
  title: string;
  description?: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Widen or narrow the dialog; the default fits a two-column form. */
  className?: string;
  /** `data-*` attributes of the button, for tests. */
  triggerAttrs?: Record<string, string>;
  /** Where the focus goes on close, when not back to the button (`preventDefault` keeps it elsewhere). */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      <DialogTrigger asChild>
        <Button {...triggerAttrs}>
          <PlusIcon /> {label}
        </Button>
      </DialogTrigger>
      <DialogContent
        className={cn("max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-xl", className)}
        {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
