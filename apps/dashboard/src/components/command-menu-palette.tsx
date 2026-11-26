"use client";

import { ArrowRightIcon, CornerDownLeftIcon, ZapIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useMemo, useState } from "react";
import { StatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { commandsForOrganization, type Command as MenuCommand, matchCommands } from "@/lib/command-menu";
import { type LiveSandbox, liveSandboxLook } from "@/lib/live-sandbox-view";

const GROUPS = ["Live sandboxes", "Actions", "Go to"] as const;

export function CommandMenuPalette({
  onDone,
  organizationAdmin,
  liveSandboxes,
}: {
  onDone: () => void;
  organizationAdmin: boolean;
  liveSandboxes: readonly LiveSandbox[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const results = useMemo(
    () => matchCommands(query, commandsForOrganization(organizationAdmin, liveSandboxes)),
    [query, organizationAdmin, liveSandboxes],
  );

  function go(command: MenuCommand) {
    onDone();
    router.push(command.href);
  }

  function item(command: MenuCommand) {
    const look = command.sandbox ? liveSandboxLook(command.sandbox) : null;
    const Icon = command.group === "Actions" ? ZapIcon : ArrowRightIcon;
    return (
      <CommandItem
        key={command.id}
        value={command.id}
        onSelect={() => go(command)}
        className="group cursor-pointer gap-2.5 rounded-md px-2.5 py-2"
      >
        {look ? (
          <StatusDot tone={look.tone} pulse={look.pulse} />
        ) : (
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="flex-1 truncate">{command.label}</span>
        {look && <span className="shrink-0 text-xs text-muted-foreground">{look.label}</span>}
        <CornerDownLeftIcon
          className="hidden size-3.5! shrink-0 text-muted-foreground group-data-[selected=true]:block"
          aria-hidden="true"
        />
      </CommandItem>
    );
  }

  return (
    <div className="relative">
      <Command shouldFilter={false} loop label="Search pages, sandboxes, and actions">
        <CommandInput
          autoFocus
          aria-label="Search pages, sandboxes, and actions"
          placeholder="Go to a page, live sandbox, or action…"
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
            : GROUPS.map((group) => {
                const items = results.filter((command) => command.group === group);
                if (items.length === 0) return null;
                return (
                  <CommandGroup
                    key={group}
                    heading={group}
                    className="p-0 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1"
                  >
                    {items.map(item)}
                  </CommandGroup>
                );
              })}
        </CommandList>
      </Command>
      <DialogPrimitive.Close asChild>
        <Button variant="ghost" size="sm" className="absolute top-2 right-2" aria-label="Close">
          <Kbd aria-hidden="true">Esc</Kbd>
        </Button>
      </DialogPrimitive.Close>
    </div>
  );
}
