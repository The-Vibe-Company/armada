"use client";

import { ArrowRightIcon, CornerDownLeftIcon, SearchIcon, ZapIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type KeyboardEvent, useEffect, useId, useMemo, useState } from "react";
import { ModKey } from "@/components/mod-key";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { type Command, matchCommands, moveActive } from "@/lib/command-menu";
import { cn } from "@/lib/utils";

/**
 * ⌘K (Ctrl+K elsewhere) from anywhere in the signed-in app: type a few letters of a page or an action, arrows to
 * choose, Enter to go. The trigger shows the shortcut, so it is discoverable without being learned.
 */
export function CommandMenu({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {compact ? (
        <Button variant="ghost" size="icon" aria-label="Search pages and actions" onClick={() => setOpen(true)}>
          <SearchIcon />
        </Button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-keyshortcuts="Meta+K Control+K"
          className="flex h-9 w-full items-center gap-2 rounded-md border bg-background px-2.5 text-sm text-muted-foreground shadow-xs transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <SearchIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 text-left">Search</span>
          <Kbd aria-hidden="true">
            <span>
              <ModKey />
            </span>
            <span>K</span>
          </Kbd>
        </button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-md"
          aria-describedby={undefined}
        >
          {open && <Palette onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Palette({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => matchCommands(query), [query]);
  const listId = useId();
  const optionId = (index: number) => `${listId}-${index}`;

  function go(command: Command | undefined) {
    if (!command) return;
    onDone();
    router.push(command.href);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => moveActive(current, event.key === "ArrowDown" ? 1 : -1, results.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(results[active]);
    }
  }

  let lastGroup: string | null = null;
  return (
    <>
      <DialogTitle className="sr-only">Search pages and actions</DialogTitle>
      <div className="flex items-center gap-2 border-b px-3">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          // biome-ignore lint/a11y/noAutofocus: the menu exists to be typed into; it opens on a keystroke.
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results[active] ? optionId(active) : undefined}
          aria-autocomplete="list"
          aria-label="Search pages and actions"
          placeholder="Go to a page or run an action…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <DialogPrimitive.Close asChild>
          <Kbd className="cursor-pointer" aria-label="Close">
            Esc
          </Kbd>
        </DialogPrimitive.Close>
      </div>
      <div id={listId} role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto p-1.5">
        {results.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches “{query.trim()}”.</p>
        )}
        {results.map((command, index) => {
          const heading = command.group !== lastGroup && !query.trim() ? command.group : null;
          lastGroup = command.group;
          const Icon = command.group === "Actions" ? ZapIcon : ArrowRightIcon;
          return (
            <div key={command.id}>
              {heading && (
                <p className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground" aria-hidden="true">
                  {heading}
                </p>
              )}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input above moves through and picks options. */}
              <div
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                tabIndex={-1}
                onMouseMove={() => setActive(index)}
                onClick={() => go(command)}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm",
                  index === active ? "bg-accent text-accent-foreground" : "text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1 truncate">{command.label}</span>
                {index === active && (
                  <CornerDownLeftIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
