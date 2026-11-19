"use client";

import { PlusIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
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
  dismissible = true,
  showCloseButton = true,
  triggerVariant = "default",
  showPlus = true,
  fixedActions = false,
}: {
  /** The header button's text, beside a plus. */
  triggerVariant?: "default" | "outline";
  showPlus?: boolean;
  /** Keep the header and actions visible while CreateDialogBody scrolls inside a form. */
  fixedActions?: boolean;
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
  /** False while closing would lose something shown only once: Escape and an outside click then do not close it. */
  dismissible?: boolean;
  showCloseButton?: boolean;
}) {
  return (
    <Dialog {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      <DialogTrigger asChild>
        <Button variant={triggerVariant} {...triggerAttrs}>
          {showPlus && <PlusIcon />} {label}
        </Button>
      </DialogTrigger>
      <DialogContent
        data-create-dialog
        showCloseButton={showCloseButton}
        className={cn(
          "max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-xl",
          fixedActions && "flex flex-col overflow-hidden [&>form]:flex [&>form]:min-h-0 [&>form]:flex-col",
          className,
        )}
        {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
        {...(dismissible
          ? {}
          : {
              onEscapeKeyDown: (event: KeyboardEvent) => event.preventDefault(),
              onInteractOutside: (event: Event) => event.preventDefault(),
            })}
      >
        <DialogHeader className="text-left">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** The shrinking scroll region of a fixed-actions create form. */
export function CreateDialogBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-h-0 overflow-y-auto overscroll-contain", className)} {...props} />;
}

export function CreateDialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("shrink-0 border-t pt-4", className)} {...props} />;
}
