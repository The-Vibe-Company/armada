"use client";

import type { Harness, SandboxProviderId } from "@armada/core";
import { CircleAlertIcon, RocketIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { launchFromGolden } from "@/app/actions/sandboxes";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ConnectionStatusBadge } from "@/components/connections";
import { type ModelCatalog, ModelFields } from "@/components/model-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { launchBlocker, launchDefaults, type McpConnection, unreadyDefaults } from "@/lib/connections";
import { PROVIDER_LABELS } from "@/lib/golden-form";
import { HARNESS_LABELS } from "@/lib/labels";
import { cn } from "@/lib/utils";

/** The selected org's connections for the launch dialog, or why they are not listed. */
export type LaunchConnections = { connections: McpConnection[] } | { unavailable: string };

/**
 * Launches an agent from a golden: harness, model, reasoning effort, the MCP connections it gets and an optional
 * first prompt. Who may open the sandbox is not a choice: its owner and the org's admins (#680).
 */
export function LaunchDialog({
  golden,
  provider,
  orgId,
  catalog,
  connections,
  repositories,
}: {
  golden: string;
  provider: SandboxProviderId;
  orgId: string;
  catalog: ModelCatalog;
  connections: LaunchConnections;
  /** The golden config's `repos[].dir`, in order. */
  repositories: readonly string[];
}) {
  const [harness, setHarness] = useState<Harness>("claude");
  // A default that is not connected holds the launch until the person reconnects it or goes on without it.
  const [held, setHeld] = useState(false);
  const id = useId();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" aria-label={`Launch from ${golden} on ${PROVIDER_LABELS[provider]}`}>
          <RocketIcon /> Launch
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Launch from {golden}</DialogTitle>
          <DialogDescription>Model and reasoning effort apply to every message.</DialogDescription>
        </DialogHeader>
        <ActionForm action={launchFromGolden} className="space-y-4">
          <input type="hidden" name="golden" value={golden} />
          <input type="hidden" name="provider" value={provider} />
          <input type="hidden" name="org" value={orgId} />
          <div className="space-y-2">
            <Label htmlFor={`${id}-harness`}>Agent</Label>
            <NativeSelect
              id={`${id}-harness`}
              name="harness"
              value={harness}
              onChange={(event) => setHarness(event.target.value as Harness)}
            >
              {(Object.keys(catalog) as Harness[]).map((value) => (
                <option key={value} value={value}>
                  {HARNESS_LABELS[value]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <ModelFields
            key={JSON.stringify([orgId, provider, golden, harness])}
            idPrefix={id}
            harness={harness}
            catalog={catalog}
          />
          <RepositoryField key={JSON.stringify([orgId, provider, golden])} idPrefix={id} repositories={repositories} />
          <AccessFields idPrefix={id} connections={connections} onHeld={setHeld} />
          <div className="space-y-2">
            <Label htmlFor={`${id}-prompt`}>First prompt</Label>
            <Textarea
              id={`${id}-prompt`}
              name="prompt"
              rows={4}
              placeholder="Optional. Leave empty for a sandbox that waits for the first message."
            />
          </div>
          {/* Only set when held: SubmitButton's own pending lock must not be overridden by `disabled={false}`. */}
          <SubmitButton {...(held ? { disabled: true } : {})}>Launch</SubmitButton>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

/** The selected configured checkout. Native reset restores the launch default without stale controlled state. */
function RepositoryField({ idPrefix, repositories }: { idPrefix: string; repositories: readonly string[] }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-repo`}>Working directory</Label>
      <NativeSelect
        id={`${idPrefix}-repo`}
        name="repo"
        defaultValue={repositories.length === 1 ? repositories[0] : ""}
        disabled={repositories.length === 0}
        aria-describedby={`${idPrefix}-repo-hint`}
      >
        <option value="">
          {repositories.length === 0 ? "No repository recorded" : "No repository (default directory)"}
        </option>
        {repositories.map((dir) => (
          <option key={dir} value={dir}>
            {dir}
          </option>
        ))}
      </NativeSelect>
      <p id={`${idPrefix}-repo-hint`} className="text-xs text-muted-foreground">
        {repositories.length === 0
          ? "No repository recorded: the agent starts in the default directory."
          : "Where the agent starts. All repositories stay available."}
      </p>
    </div>
  );
}

/**
 * Connections, by the #681 selection. It starts with every enabled include-by-default connection, personal and org,
 * whatever the golden's visibility; from the person's first change it is exactly what they ticked, and an empty
 * selection launches with none. A default that is not connected is never dropped silently: it holds the launch until
 * it is reconnected or the person chooses to continue without it, as the server does.
 */
function AccessFields({
  idPrefix,
  connections,
  onHeld,
}: {
  idPrefix: string;
  connections: LaunchConnections;
  onHeld: (held: boolean) => void;
}) {
  // Null until the person changes the selection: the defaults apply until then.
  const [picked, setPicked] = useState<string[] | null>(null);
  // A requested default that is not connected holds the launch until the person reconnects it or explicitly goes
  // on without it. Ticking other connections does not count: it would drop the default without saying so.
  const [waived, setWaived] = useState<readonly string[]>([]);
  const group = useRef<HTMLDivElement>(null);
  const list = "connections" in connections ? connections.connections : [];
  const blocked = unreadyDefaults(list);
  // A default that is not connected cannot be ticked: it is held below rather than submitted or dropped unseen.
  const chosen = picked ?? launchDefaults(list).filter((item) => !blocked.some((connection) => connection.id === item));
  const setChosen = (next: string[]) => setPicked(next);
  const unready = blocked.filter((connection) => !waived.includes(connection.id));
  useEffect(() => onHeld(unready.length > 0), [unready.length, onHeld]);

  /** Goes on without the unready defaults; the notice and its button leave, so focus moves to the connection list. */
  function continueWithout() {
    setWaived([...waived, ...unready.map((connection) => connection.id)]);
    setPicked(chosen);
    group.current?.querySelector<HTMLInputElement>('input[name="connections"]:not(:disabled)')?.focus();
  }

  // Native reset after a launch attempt empties the DOM; the controlled state must follow it.
  useEffect(() => {
    const form = group.current?.closest("form");
    const reset = () => {
      setPicked(null);
      setWaived([]);
    };
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, []);

  function toggle(connectionId: string, on: boolean) {
    setChosen(on ? [...chosen, connectionId] : chosen.filter((item) => item !== connectionId));
  }

  const personal = list.filter((item) => item.scope === "personal");
  const shared = list.filter((item) => item.scope === "org");

  return (
    <div ref={group} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">MCP connections</legend>
        {unready.length > 0 && (
          <div
            role="alert"
            data-unready-defaults
            className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs"
          >
            <CircleAlertIcon className="size-4 shrink-0 text-warning" />
            <span className="min-w-48 flex-1">
              {unready.map((connection) => connection.name).join(", ")}{" "}
              {unready.length === 1 ? "is a default but is" : "are defaults but are"} not connected.{" "}
              <Link href="/connections" className="underline">
                Reconnect
              </Link>{" "}
              or continue without {unready.length === 1 ? "it" : "them"}.
            </span>
            <Button type="button" variant="outline" size="xs" onClick={continueWithout}>
              Continue without {unready.length === 1 ? "it" : "them"}
            </Button>
          </div>
        )}
        {"unavailable" in connections ? (
          <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
            Connections could not be loaded: {connections.unavailable} You can still launch without them.
          </p>
        ) : list.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            No connections.{" "}
            <Link href="/connections" className="underline">
              Add one
            </Link>
          </p>
        ) : (
          <div className="space-y-3">
            {[
              ["Your personal connections", personal],
              ["Org connections", shared],
            ].map(([title, items]) =>
              (items as McpConnection[]).length === 0 ? null : (
                <div key={title as string} className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{title as string}</p>
                  <ul className="divide-y rounded-md border">
                    {(items as McpConnection[]).map((connection) => (
                      <ConnectionOption
                        key={connection.id}
                        idPrefix={idPrefix}
                        connection={connection}
                        blocker={launchBlocker(connection)}
                        checked={chosen.includes(connection.id)}
                        onChange={(on) => toggle(connection.id, on)}
                      />
                    ))}
                  </ul>
                </div>
              ),
            )}
          </div>
        )}
      </fieldset>
    </div>
  );
}

function ConnectionOption({
  idPrefix,
  connection,
  blocker,
  checked,
  onChange,
}: {
  idPrefix: string;
  connection: McpConnection;
  blocker: string | null;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const inputId = `${idPrefix}-connection-${connection.id}`;
  return (
    <li className={cn("flex items-start gap-3 p-3", blocker && "opacity-70")}>
      <input
        id={inputId}
        type="checkbox"
        name="connections"
        value={connection.id}
        checked={checked && !blocker}
        disabled={blocker !== null}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={`${inputId}-hint`}
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={inputId} className="font-medium">
            {connection.name}
          </Label>
          <ConnectionStatusBadge connection={connection} />
          {connection.defaultForLaunch && (
            <span className="text-xs text-muted-foreground" data-default-for-launch>
              Default
            </span>
          )}
        </div>
        <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
          {blocker ??
            [
              connection.accountLabel ? `As ${connection.accountLabel}` : null,
              connection.transport === "stdio"
                ? "Starts inside the sandbox"
                : connection.toolCount !== undefined
                  ? `${connection.toolCount} tools`
                  : null,
            ]
              .filter(Boolean)
              .join(" · ")}
        </p>
      </div>
    </li>
  );
}
