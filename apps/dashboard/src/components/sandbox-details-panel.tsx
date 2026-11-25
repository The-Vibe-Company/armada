"use client";

import { PanelRightIcon } from "lucide-react";
import { Tabs } from "radix-ui";
import { createContext, type ReactNode, useContext, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DESKTOP = "(min-width: 64rem)";

function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const EventsTarget = createContext<HTMLDivElement | null>(null);

export function SandboxInspectorEvents({ children }: { children: ReactNode }) {
  const target = useContext(EventsTarget);
  return target && createPortal(children, target);
}

export function SandboxDetailsPanel({
  bar,
  overview,
  usage,
  children,
}: {
  bar: ReactNode;
  overview: ReactNode;
  usage: ReactNode;
  children: ReactNode;
}) {
  const desktop = useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP).matches,
    () => undefined,
  );
  const [open, setOpen] = useState<boolean>();
  const [events, setEvents] = useState<HTMLDivElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const panelId = useId();

  function toggle() {
    const next = !(open ?? desktop);
    setOpen(next);
    if (next && !desktop) requestAnimationFrame(() => panel.current?.scrollIntoView({ block: "nearest" }));
  }

  return (
    <>
      <header className="sticky top-0 z-20 flex h-12 min-w-0 items-center gap-1 border-b bg-background sm:gap-2">
        {bar}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Sandbox details"
          title="Toggle inspector"
          aria-controls={panelId}
          aria-expanded={open ?? desktop}
          onClick={toggle}
        >
          <PanelRightIcon className="size-4" aria-hidden />
        </Button>
      </header>
      <div
        data-fit="body"
        className={cn(
          "grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-3 lg:gap-5",
          open !== false && "lg:grid-cols-[minmax(0,1fr)_300px]",
        )}
      >
        <div data-fit="column" className="min-w-0 space-y-3">
          <EventsTarget.Provider value={events}>{children}</EventsTarget.Provider>
        </div>
        <section
          id={panelId}
          ref={panel}
          aria-label="Sandbox inspector"
          data-fit="side"
          className={cn(
            "min-w-0 scroll-mt-12 flex-col rounded-xl border bg-[var(--surface)] p-2 lg:sticky lg:top-14",
            open === undefined ? "hidden lg:flex" : open ? "flex" : "hidden",
          )}
        >
          <Tabs.Root defaultValue="overview" className="min-w-0">
            <Tabs.List
              aria-label="Inspector sections"
              className="grid grid-cols-[1fr_1.35fr_.75fr] gap-0.5 rounded-lg bg-muted p-0.5"
            >
              {(
                [
                  ["overview", "Overview"],
                  ["usage", "Usage & Tools"],
                  ["events", "Events"],
                ] as const
              ).map(([value, label]) => (
                <Tabs.Trigger
                  key={value}
                  value={value}
                  className="rounded-md px-1 py-1.5 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                >
                  {label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <div
              data-fit="side-content"
              className="max-h-[55dvh] overflow-auto p-2 font-sans tabular-nums lg:max-h-[calc(100dvh-7rem)]"
            >
              <Tabs.Content value="overview" className="space-y-4">
                {overview}
              </Tabs.Content>
              <Tabs.Content value="usage" className="space-y-4">
                {usage}
              </Tabs.Content>
              <Tabs.Content value="events">
                <div ref={setEvents} />
              </Tabs.Content>
            </div>
          </Tabs.Root>
        </section>
      </div>
    </>
  );
}
