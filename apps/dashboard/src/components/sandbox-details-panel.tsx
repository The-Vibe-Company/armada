"use client";

import { PanelRightIcon, TerminalIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { Tabs } from "radix-ui";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import styles from "@/components/sandbox-details-panel.module.css";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SandboxTerminal = dynamic(() => import("@/components/sandbox-terminal").then((m) => m.SandboxTerminal), {
  ssr: false,
  loading: () => (
    <div className="flex h-[272px] shrink-0 items-center justify-center rounded-xl border bg-[var(--sunken)] font-mono text-xs text-muted-foreground">
      Loading terminal…
    </div>
  ),
});

const DESKTOP = "(min-width: 64rem)";

const PHONE = "(width < 48rem)";

function subscribeToViewport(onChange: () => void) {
  const query = window.matchMedia(DESKTOP);
  const phone = window.matchMedia(PHONE);
  phone.addEventListener("change", onChange);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
    phone.removeEventListener("change", onChange);
  };
}

// The transcript owns the event read and supplies the Events tab from the same history.
const EventsTarget = createContext<HTMLDivElement | null>(null);
const PhoneTarget = createContext<(target: HTMLDivElement | null) => void>(() => {});

export function SandboxInspectorPhoneSlot() {
  const ref = useContext(PhoneTarget);
  return <div id="sandbox-mobile-about" className="md:hidden" ref={ref} />;
}

export function SandboxInspectorEvents({ children }: { children: ReactNode }) {
  const target = useContext(EventsTarget);
  return target && createPortal(children, target);
}

export function SandboxDetailsPanel({
  bar,
  overview,
  usage,
  terminalSandboxId,
  children,
}: {
  bar: ReactNode;
  overview: ReactNode;
  usage: ReactNode;
  terminalSandboxId?: string | undefined;
  children: ReactNode;
}) {
  // Responsive CSS reserves the rail on first paint; the media query only supplies the toggle state.
  const desktop = useSyncExternalStore(
    subscribeToViewport,
    () => window.matchMedia(DESKTOP).matches,
    () => undefined,
  );
  const phone = useSyncExternalStore(
    subscribeToViewport,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
  const [phoneTarget, setPhoneTarget] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState<boolean>();
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [events, setEvents] = useState<HTMLDivElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!terminalSandboxId) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey && ev.code === "Backquote") {
        ev.preventDefault();
        setTerminalOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [terminalSandboxId]);

  function toggle() {
    const next = !(open ?? desktop);
    setOpen(next);
    if (next && !desktop) requestAnimationFrame(() => panel.current?.scrollIntoView({ block: "nearest" }));
  }

  const inspector = (
    <section
      id={panelId}
      ref={panel}
      aria-label="Sandbox inspector"
      data-state={open === undefined ? "default" : open ? "open" : "closed"}
      data-fit="side"
      className={cn(
        styles.rail,
        "flex min-w-0 scroll-mt-12 flex-col rounded-xl border bg-[var(--surface)] p-2 lg:sticky lg:top-14",
      )}
    >
      <Tabs.Root defaultValue="overview" className="flex min-h-0 min-w-0 flex-col">
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
  );

  return (
    <>
      <header className="sticky top-0 z-20 flex h-12 min-w-0 items-center gap-1 border-b bg-background sm:gap-2">
        {bar}
        {terminalSandboxId && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={terminalOpen}
            aria-label="Toggle terminal"
            title="Toggle terminal (Ctrl+`)"
            onClick={() => setTerminalOpen((prev) => !prev)}
            className={cn("max-sm:px-2", terminalOpen && "bg-accent text-accent-foreground")}
          >
            <TerminalIcon className="size-4" aria-hidden />
            <span className="hidden sm:inline">Terminal</span>
          </Button>
        )}
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
        <div data-fit="column" className="min-h-0 min-w-0 space-y-3">
          <PhoneTarget.Provider value={setPhoneTarget}>
            <EventsTarget.Provider value={events}>{children}</EventsTarget.Provider>
          </PhoneTarget.Provider>
          {terminalSandboxId && terminalOpen && (
            <SandboxTerminal sandboxId={terminalSandboxId} onClose={() => setTerminalOpen(false)} />
          )}
        </div>
        {phone && phoneTarget && open ? createPortal(inspector, phoneTarget) : inspector}
      </div>
    </>
  );
}
