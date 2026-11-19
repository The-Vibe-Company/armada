"use client";

import { ChevronDownIcon, CircleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { ConnectionStatusBadge } from "@/components/connections";
import type { useLaunchAccess } from "@/components/launch-dialog";
import { useLaunchPhone } from "@/components/launch-surface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { connectAction, launchBlocker, type McpConnection } from "@/lib/connections";
import { launchToolGroups, rememberLaunchToolSelection, toolInitials } from "@/lib/launch-tools";

export function LaunchTools({ access, idPrefix }: { access: ReturnType<typeof useLaunchAccess>; idPrefix: string }) {
  const phone = useLaunchPhone();
  const warning = access.held || access.unavailable;
  const summary = access.unavailable
    ? "Unavailable"
    : access.selectedTools.map((tool) => tool.name).join(", ") || "None";
  const trigger = (
    <Button type="button" variant="outline" size="sm" className="max-w-full pointer-coarse:min-h-11">
      Tools
      {warning && <CircleAlertIcon aria-hidden="true" className="text-warning" />}
      {access.held && <span className="sr-only">Needs attention</span>}
      {access.selectedTools.slice(0, 3).map((tool) => (
        <span
          key={tool.id}
          aria-hidden="true"
          className="grid size-5 shrink-0 place-items-center rounded bg-muted text-[10px]"
        >
          {toolInitials(tool.name)}
        </span>
      ))}
      <span className="truncate font-normal text-muted-foreground">{summary}</span>
      <ChevronDownIcon aria-hidden="true" />
    </Button>
  );
  const menu = (
    <ToolMenu
      idPrefix={idPrefix}
      tools={access.list}
      unavailable={access.unavailable}
      chosen={access.chosen}
      changed={access.changed}
      onChange={access.toggle}
      onReset={access.reset}
    />
  );
  return phone ? (
    <Sheet>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent side="bottom" aria-describedby={undefined} className="max-h-[85dvh] overflow-y-auto p-4">
        <SheetTitle>Tools</SheetTitle>
        {menu}
      </SheetContent>
    </Sheet>
  ) : (
    <Popover modal>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Tools"
        className="max-h-[var(--radix-popover-content-available-height)] w-80 overflow-y-auto p-3"
      >
        {menu}
      </PopoverContent>
    </Popover>
  );
}

function ToolMenu({
  idPrefix,
  tools,
  unavailable,
  chosen,
  changed,
  onChange,
  onReset,
}: {
  idPrefix: string;
  tools: McpConnection[];
  unavailable: boolean;
  chosen: readonly string[];
  changed: boolean;
  onChange: (id: string, checked: boolean) => void;
  onReset: () => void;
}) {
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const connectLink = useRef<HTMLAnchorElement>(null);
  const [initialSelection, setInitialSelection] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const selectionWithNewTools = rememberLaunchToolSelection(initialSelection, tools, chosen);
  if (selectionWithNewTools !== initialSelection) setInitialSelection(selectionWithNewTools);
  const search = query.trim().toLowerCase();
  const visible = launchToolGroups(tools, initialSelection)
    .map(({ title, tools: entries }) => ({
      title,
      tools: entries.filter((tool) =>
        `${tool.name} ${tool.scope} ${tool.accountLabel ?? ""}`.toLowerCase().includes(search),
      ),
    }))
    .filter((group) => group.tools.length > 0);
  return (
    <div className="space-y-3">
      {tools.length > 0 ? (
        <Input
          ref={searchInput}
          aria-label="Search tools"
          placeholder="Search tools"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : unavailable ? (
        <p className="p-2 text-sm text-muted-foreground">Connections could not be loaded.</p>
      ) : (
        <p className="p-2 text-sm text-muted-foreground">
          No connections.{" "}
          <Link href="/tools" className="underline">
            Add one
          </Link>
        </p>
      )}
      {visible.map(({ title, tools: entries }) => (
        <section key={title} aria-label={title}>
          <p className="px-2 py-1 text-xs font-medium text-muted-foreground">{title}</p>
          <ul className="divide-y rounded-md border">
            {entries.map((connection) => (
              <ConnectionOption
                key={connection.id}
                idPrefix={idPrefix}
                connection={connection}
                checked={chosen.includes(connection.id)}
                onChange={(checked) => onChange(connection.id, checked)}
              />
            ))}
          </ul>
        </section>
      ))}
      {tools.length > 0 && visible.length === 0 && (
        <p className="p-2 text-sm text-muted-foreground">No matching tools.</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-1 border-t pt-2">
        {changed && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              (searchInput.current ?? connectLink.current)?.focus();
              onReset();
            }}
          >
            Back to your defaults
          </Button>
        )}
        <Button asChild variant="ghost" size="sm" className="ml-auto">
          <Link ref={connectLink} href="/tools">Connect a tool</Link>
        </Button>
      </div>
    </div>
  );
}

function ConnectionOption({
  idPrefix,
  connection,
  checked,
  onChange,
}: {
  idPrefix: string;
  connection: McpConnection;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const inputId = `${idPrefix}-connection-${connection.id}`;
  const blocker = launchBlocker(connection);
  const hint =
    blocker ??
    [
      connection.accountLabel ? `As ${connection.accountLabel}` : null,
      connection.transport === "stdio"
        ? "Starts inside the sandbox"
        : connection.toolCount !== undefined
          ? `${connection.toolCount} ${connection.toolCount === 1 ? "tool" : "tools"}`
          : null,
      connection.scope === "personal" ? "Personal" : "Organization",
    ]
      .filter(Boolean)
      .join(" · ");
  const recovery = connectAction(connection) ?? "Enable";
  return (
    <li className="flex min-h-11 items-center gap-2 px-2 py-2">
      <span
        aria-hidden="true"
        className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-xs font-medium"
      >
        {toolInitials(connection.name)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {blocker ? (
            <span className="text-sm font-medium">{connection.name}</span>
          ) : (
            <Label htmlFor={inputId}>{connection.name}</Label>
          )}
          <ConnectionStatusBadge connection={connection} />
          {connection.defaultForLaunch && (
            <span data-default-for-launch className="text-xs text-muted-foreground">
              Default
            </span>
          )}
        </div>
        <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      </div>
      {blocker ? (
        <Link href="/tools" className="px-1 text-sm underline">
          {recovery}
        </Link>
      ) : (
        <Button
          id={inputId}
          type="button"
          variant="ghost"
          size="icon"
          role="switch"
          aria-checked={checked}
          aria-describedby={`${inputId}-hint`}
          onClick={() => onChange(!checked)}
          className="group w-10 focus-visible:ring-ring pointer-coarse:size-11 hover:bg-transparent"
        >
          <span
            aria-hidden="true"
            className="flex h-5 w-9 items-center rounded-full bg-input px-0.5 group-aria-checked:bg-primary"
          >
            <span className="size-4 rounded-full bg-background shadow-sm transition-transform group-aria-checked:translate-x-4 motion-reduce:transition-none" />
          </span>
        </Button>
      )}
    </li>
  );
}
