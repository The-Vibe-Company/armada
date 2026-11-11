"use client";

import { CircleAlertIcon, CircleCheckIcon, InfoIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useTheme } from "next-themes";
import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/** The shadcn Sonner composition, using the dashboard's existing surface and status tokens. */
export function Toaster(props: ToasterProps) {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as NonNullable<ToasterProps["theme"]>}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon aria-hidden="true" className="size-4 text-success" />,
        error: <CircleAlertIcon aria-hidden="true" className="size-4 text-destructive" />,
        info: <InfoIcon aria-hidden="true" className="size-4 text-info" />,
        warning: <TriangleAlertIcon aria-hidden="true" className="size-4 text-warning" />,
        loading: <Loader2Icon aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />,
      }}
      style={
        {
          "--normal-bg": "var(--card)",
          "--normal-text": "var(--card-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          fontFamily: "var(--font-sans)",
        } as CSSProperties
      }
      toastOptions={{
        closeButtonAriaLabel: "Dismiss",
        classNames: {
          toast: "!gap-3 !text-sm !shadow-lg focus-visible:!ring-2 focus-visible:!ring-ring",
          description: "!text-muted-foreground",
          error: "!border-destructive/40",
          closeButton: "focus-visible:!ring-2 focus-visible:!ring-ring",
        },
      }}
      {...props}
    />
  );
}
