"use client";

import { CircleAlertIcon, CircleCheckIcon, XIcon } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { useSyncExternalStore } from "react";
import { addToast, closeToast, TOAST_DURATION, type ToastInput, type ToastItem } from "@/lib/toast";
import { cn } from "@/lib/utils";

type Show = (toast: ToastInput) => void;

/*
 * The toasts of this tab, in a module store rather than a context: the `Toaster` is a leaf of the shell, so the shell
 * and the pages under it render (and hydrate) exactly as they would without toasts.
 */
let toasts: ToastItem[] = [];
let lastId = 0;
const listeners = new Set<() => void>();
const NONE: ToastItem[] = [];

function emit(next: ToastItem[]) {
  toasts = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const show: Show = (toast) => {
  lastId += 1;
  emit(addToast(toasts, { ...toast, id: lastId }));
};

/**
 * Shows a transient confirmation for an action whose result lands away from where the person is looking (a dialog
 * that closed, a row that moved or left the list). Forms keep their inline result: it stays next to the field to fix.
 * The function is stable, and safe to call from an action after the calling component unmounted.
 */
export function useToast(): Show {
  return show;
}

/**
 * The toast region of the signed-in shell. Toasts never take focus: a success is announced politely, a failure
 * assertively, the way an inline result would be. F8 moves focus to the region, Escape closes the focused toast, and
 * a toast pauses while it is hovered or focused.
 */
export function Toaster() {
  const list = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => NONE,
  );
  return (
    <ToastPrimitive.Provider swipeDirection="right" label="Notification">
      {list.map((toast) => (
        <Toast
          key={toast.id}
          toast={toast}
          onOpenChange={(open) => {
            if (!open) emit(closeToast(toasts, toast.id));
          }}
        />
      ))}
      <ToastPrimitive.Viewport
        data-slot="toast-viewport"
        className="pointer-events-none fixed right-0 bottom-0 z-[100] flex max-h-dvh w-full flex-col gap-2 p-4 outline-none sm:max-w-sm"
      />
    </ToastPrimitive.Provider>
  );
}

function Toast({ toast, onOpenChange }: { toast: ToastItem; onOpenChange: (open: boolean) => void }) {
  const Icon = toast.tone === "success" ? CircleCheckIcon : CircleAlertIcon;
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      data-tone={toast.tone}
      open={toast.open}
      onOpenChange={onOpenChange}
      type={toast.tone === "success" ? "background" : "foreground"}
      duration={TOAST_DURATION[toast.tone]}
      className={cn(
        "group pointer-events-auto relative flex w-full items-start gap-3 rounded-lg border bg-card p-4 pr-10 text-sm text-card-foreground shadow-lg",
        toast.tone === "destructive" && "border-destructive/40",
        "data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-full data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-2 data-[swipe=end]:animate-out",
        "motion-reduce:animate-none motion-reduce:transition-none",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("mt-0.5 size-4 shrink-0", toast.tone === "success" ? "text-success" : "text-destructive")}
      />
      <div className="grid min-w-0 gap-0.5">
        <ToastPrimitive.Title data-slot="toast-title" className="font-medium">
          {toast.title}
        </ToastPrimitive.Title>
        {toast.description && (
          <ToastPrimitive.Description data-slot="toast-description" className="text-muted-foreground">
            {toast.description}
          </ToastPrimitive.Description>
        )}
      </div>
      <ToastPrimitive.Close
        aria-label="Dismiss"
        className="absolute top-3 right-3 rounded-sm p-0.5 text-muted-foreground opacity-70 transition-opacity outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
      >
        <XIcon aria-hidden="true" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}
