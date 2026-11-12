"use client";

import { ArrowRightIcon, CornerDownLeftIcon, SearchIcon, ZapIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { ModKey } from "@/components/mod-key";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { type Command as MenuCommand, matchCommands } from "@/lib/command-menu";

/** The event a trigger sends to open the one menu of the page. */
const OPEN_EVENT = "armada:command-menu";

/**
 * ⌘K (Ctrl+K elsewhere) from anywhere in the signed-in app: type a few letters of a page or an action, arrows to
 * choose, Enter to go. Mounted once per page; any `CommandMenuTrigger` opens it.
 */
export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const openingFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        if (!open) openingFocus.current = document.activeElement as HTMLElement | null;
        setOpen((value) => !value);
      }
    }
    const onOpen = () => {
      openingFocus.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-md"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          openingFocus.current?.focus();
        }}
      >
        {open && <Palette onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** A button that opens the command menu and shows its shortcut, so it is discoverable without being learned. */
export function CommandMenuTrigger({ compact = false }: { compact?: boolean }) {
  const open = () => window.dispatchEvent(new Event(OPEN_EVENT));
  if (compact)
    return (
      <Button variant="ghost" size="icon" aria-label="Search pages and actions" onClick={open}>
        <SearchIcon />
      </Button>
    );
  return (
    <Button
      type="button"
      variant="outline"
      onClick={open}
      aria-keyshortcuts="Meta+K Control+K"
      className="w-full bg-background px-2.5 font-normal text-muted-foreground has-[>svg]:px-2.5"
    >
      <SearchIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 text-left">Search</span>
      <Kbd aria-hidden="true">
        <span>
          <ModKey />
        </span>
        <span>K</span>
      </Kbd>
    </Button>
  );
}

function Palette({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const results = useMemo(() => matchCommands(query), [query]);

  function go(command: MenuCommand) {
    onDone();
    router.push(command.href);
  }

  function item(command: MenuCommand) {
    const Icon = command.group === "Actions" ? ZapIcon : ArrowRightIcon;
    return (
      <CommandItem
        key={command.id}
        value={command.id}
        onSelect={() => go(command)}
        className="group cursor-pointer gap-2.5 rounded-md px-2.5 py-2"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1 truncate">{command.label}</span>
        <CornerDownLeftIcon
          className="hidden size-3.5! shrink-0 text-muted-foreground group-data-[selected=true]:block"
          aria-hidden="true"
        />
      </CommandItem>
    );
  }

  return (
    <>
      <DialogTitle className="sr-only">Search pages and actions</DialogTitle>
      <div className="relative">
        <Command shouldFilter={false} loop label="Search pages and actions">
          <CommandInput
            autoFocus
            aria-label="Search pages and actions"
            placeholder="Go to a page or run an action…"
            value={query}
            onValueChange={setQuery}
            className="h-12 pr-14"
          />
          <CommandList label="Results" className="max-h-80 p-1.5">
            <CommandEmpty className="px-3 py-6 text-center text-sm text-muted-foreground">
              Nothing matches “{query.trim()}”.
            </CommandEmpty>
            {query.trim()
              ? results.map(item)
              : (["Actions", "Go to"] as const).map((group) => (
                  <CommandGroup
                    key={group}
                    heading={group}
                    className="p-0 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1"
                  >
                    {results.filter((command) => command.group === group).map(item)}
                  </CommandGroup>
                ))}
          </CommandList>
        </Command>
        <DialogPrimitive.Close asChild>
          <Button variant="ghost" size="sm" className="absolute top-2 right-2" aria-label="Close">
            <Kbd aria-hidden="true">Esc</Kbd>
          </Button>
        </DialogPrimitive.Close>
      </div>
    </>
  );
}
