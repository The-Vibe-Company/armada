"use client";

import { CircleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { ConnectionStatusBadge } from "@/components/connections";
import { LaunchChip } from "@/components/launch-composer";
import type { LaunchConnections } from "@/components/launch-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectAction, launchBlocker, launchDefaults, type McpConnection, unreadyDefaults } from "@/lib/connections";
import { launchToolsSummary } from "@/lib/launch-composer";
import { launchToolGroups, rememberLaunchToolSelection, toolInitials } from "@/lib/launch-tools";

export function useLaunchAccess(connections: LaunchConnections) {
  const [picked, setPicked] = useState<string[] | null>(null);
  const [waived, setWaived] = useState<readonly string[]>([]);
  const list = "connections" in connections ? connections.connections : [];
  const blocked = unreadyDefaults(list);
  const chosen = picked ?? launchDefaults(list).filter((item) => !blocked.some((connection) => connection.id === item));
  const unready = blocked.filter((connection) => !waived.includes(connection.id));

  function toggle(connectionId: string, on: boolean) {
    setPicked(on ? [...chosen, connectionId] : chosen.filter((item) => item !== connectionId));
  }

  const alerts = (onContinue: () => void, idPrefix: string) => (
    <>
      {unready.length > 0 && (
        <div data-unready-defaults className="contents">
          <p
            id={`${idPrefix}-held`}
            role="alert"
            tabIndex={-1}
            className="flex basis-full items-center gap-2 text-xs text-warning"
          >
            <CircleAlertIcon className="size-4 shrink-0" />
            {unready.map((connection) => connection.name).join(", ")}{" "}
            {unready.length === 1
              ? "is on by default but is not connected."
              : "are on by default but are not connected."}
          </p>
          <Button asChild type="button" variant="outline" size="sm">
            <Link href="/tools">Reconnect</Link>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setWaived([...waived, ...unready.map((connection) => connection.id)]);
              setPicked(chosen);
              onContinue();
            }}
          >
            Launch without {unready.length === 1 ? "it" : "them"}
          </Button>
        </div>
      )}
      {"unavailable" in connections && (
        <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
          Connections could not be loaded: {connections.unavailable} A launch uses your default connections, and is
          refused if one of them is not connected.
        </p>
      )}
    </>
  );

  const fields = (idPrefix: string) => (
    <ToolMenu
      idPrefix={idPrefix}
      tools={list}
      unavailable={"unavailable" in connections}
      chosen={chosen}
      onChange={toggle}
      changed={picked !== null}
      onReset={() => {
        setPicked(null);
        setWaived([]);
      }}
    />
  );
  const selectedTools = list.filter((connection) => chosen.includes(connection.id) && !launchBlocker(connection));

  return {
    explicit: picked !== null && "connections" in connections,
    selected: selectedTools.length,
    selectedTools,
    inputs: selectedTools.map((connection) => (
      <input key={connection.id} type="hidden" name="connections" value={connection.id} />
    )),
    selectedName: selectedTools[0]?.name,
    held: unready.length > 0,
    unavailable: "unavailable" in connections,
    alerts,
    fields,
  };
}

export function LaunchTools({ access, idPrefix }: { access: ReturnType<typeof useLaunchAccess>; idPrefix: string }) {
  const names = access.selectedTools.map((tool) => tool.name);
  const summary = names.length > 1 ? names.join(", ") : launchToolsSummary(access);
  return (
    <LaunchChip
      title="Tools"
      label={`Tools · ${summary}`}
      warning={access.held || access.unavailable}
      prefix={
        access.selectedTools.length
          ? access.selectedTools.slice(0, 3).map((tool) => (
              <span key={tool.id} className="grid size-5 place-items-center rounded bg-muted text-[10px] font-medium">
                {toolInitials(tool.name)}
              </span>
            ))
          : undefined
      }
    >
      {access.fields(idPrefix)}
    </LaunchChip>
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
          <Link ref={connectLink} href="/tools">
            Connect a tool
          </Link>
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
