"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { shouldIgnoreGlobalShortcut } from "@/lib/shortcut";
import { cn } from "@/lib/utils";

export type SandboxListRowItem = { id: string; canOpen: boolean; content: ReactNode };

const INTERACTIVE = 'a, button, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"]';

export function SandboxListRows({ rows }: { rows: SandboxListRowItem[] }) {
  const router = useRouter();
  const toast = useToast();
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const stateRef = useRef({ rows, focusedId });
  stateRef.current = { rows, focusedId };

  useEffect(() => {
    if (focusedId && !rows.some((row) => row.id === focusedId)) setFocusedId(null);
  }, [rows, focusedId]);

  useEffect(() => {
    function move(delta: 1 | -1) {
      const { rows: list, focusedId: cur } = stateRef.current;
      if (!list.length) return;
      const idx = cur ? list.findIndex((row) => row.id === cur) : -1;
      const next =
        list[idx === -1 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, idx + delta))];
      if (!next) return;
      stateRef.current.focusedId = next.id;
      setFocusedId(next.id);
      const node = rowRefs.current.get(next.id);
      node?.focus?.({ preventScroll: true });
      node?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
    }

    function onKeyDown(event: KeyboardEvent) {
      const { rows: list, focusedId: cur } = stateRef.current;
      if (!list.length) return;
      if (event.key === "j" || event.key === "ArrowDown" || event.key === "k" || event.key === "ArrowUp") {
        if (shouldIgnoreGlobalShortcut(event, { allowRepeat: true })) return;
        event.preventDefault();
        move(event.key === "j" || event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Escape" && cur && !shouldIgnoreGlobalShortcut(event)) {
        stateRef.current.focusedId = null;
        setFocusedId(null);
        return;
      }
      const active = cur ? list.find((row) => row.id === cur) : undefined;
      if (!active || shouldIgnoreGlobalShortcut(event)) return;
      if (event.key === "Enter") {
        const el = event.target as { closest?: (s: string) => unknown } | null;
        if (el && typeof el.closest === "function" && el.closest(INTERACTIVE)) return;
        if (!active.canOpen) return;
        event.preventDefault();
        router.push(`/sandboxes/${active.id}`);
      } else if (event.key === "c") {
        event.preventDefault();
        void (navigator.clipboard?.writeText(active.id) ?? Promise.reject(new Error("Clipboard unavailable")))
          .then(() => toast({ title: "Sandbox ID copied", tone: "success" }))
          .catch(() => toast({ title: "Could not copy ID", tone: "destructive" }));
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, toast]);

  return rows.map((row) => {
    const focused = focusedId === row.id;
    return (
      <div
        key={row.id}
        tabIndex={-1}
        ref={(node) => {
          if (node) rowRefs.current.set(row.id, node);
          else rowRefs.current.delete(row.id);
        }}
        data-sandbox-row={row.id}
        data-kb-focused={focused || undefined}
        className={cn(
          "outline-none last:rounded-b-xl max-md:first:rounded-t-xl [&>article]:last:rounded-b-xl max-md:[&>article]:first:rounded-t-xl",
          focused && "bg-[var(--raised)]/80 ring-2 ring-ring ring-inset",
        )}
      >
        {row.content}
      </div>
    );
  });
}
