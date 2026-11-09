"use client";

import type { Harness, SandboxProviderId } from "@armada/core";
import { CircleAlertIcon, GlobeIcon, LockIcon, RocketIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { launchFromGolden } from "@/app/actions/sandboxes";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ChoiceCard, ConnectionStatusBadge } from "@/components/connections";
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
import {
  launchBlocker,
  launchDefaults,
  type McpConnection,
  type SandboxVisibility,
  unreadyDefaults,
} from "@/lib/connections";
import { PROVIDER_LABELS } from "@/lib/golden-form";
import { HARNESS_LABELS } from "@/lib/labels";
import { cn } from "@/lib/utils";

/** The selected org's connections for the launch dialog, or why they are not listed. */
export type LaunchConnections = { connections: McpConnection[] } | { unavailable: string };

/**
 * Launches an agent from a golden: harness, model, reasoning effort, who sees the sandbox, the MCP
 * connections it gets and an optional first prompt.
 */
export function LaunchDialog({
  golden,
  provider,
  orgId,
  catalog,
  goldenVisibility,
  connections,
  repositories,
}: {
  golden: string;
  provider: SandboxProviderId;
  orgId: string;
  catalog: ModelCatalog;
  goldenVisibility: SandboxVisibility;
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
          <AccessFields idPrefix={id} goldenVisibility={goldenVisibility} connections={connections} onHeld={setHeld} />
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
 * Visibility and connections. The selection starts with the connections marked include-by-default that this
 * sandbox can use, and follows the visibility until the person changes it; from then on it is exactly what they
 * ticked, and an empty selection launches with none. A requested default that is not connected is never dropped
 * silently: it holds the launch until it is reconnected or the person chooses to continue without it, as the server
 * does for a launch that names no connections. A personal connection carries its owner's identity, so it can only
 * go into a private sandbox: it is not selectable while Org is chosen, and choosing Org drops it.
 */
function AccessFields({
  idPrefix,
  goldenVisibility,
  connections,
  onHeld,
}: {
  idPrefix: string;
  goldenVisibility: SandboxVisibility;
  connections: LaunchConnections;
  onHeld: (held: boolean) => void;
}) {
  const [visibility, setVisibility] = useState<SandboxVisibility>(goldenVisibility);
  // Null until the person changes the selection: the defaults for the current visibility apply until then.
  const [picked, setPicked] = useState<string[] | null>(null);
  // A requested default that is not connected holds the launch until the person reconnects it or explicitly goes
  // on without it. Ticking other connections does not count: it would drop the default without saying so.
  // By id, so a default that only becomes eligible later (switching to Private) is held again, not waived unseen.
  const [waived, setWaived] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState("");
  const group = useRef<HTMLDivElement>(null);
  const list = "connections" in connections ? connections.connections : [];
  const chosen = picked ?? launchDefaults(list, visibility);
  const setChosen = (next: string[]) => setPicked(next);
  const unready = unreadyDefaults(list, visibility).filter((connection) => !waived.includes(connection.id));
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
      setVisibility(goldenVisibility);
      setPicked(null);
      setWaived([]);
      setNotice("");
    };
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, [goldenVisibility]);

  function choose(next: SandboxVisibility) {
    setVisibility(next);
    if (next !== "org" || picked === null) return setNotice("");
    const personal = chosen.filter((item) => list.find((connection) => connection.id === item)?.scope === "personal");
    if (personal.length === 0) return setNotice("");
    setChosen(chosen.filter((item) => !personal.includes(item)));
    setNotice(
      `${personal.length === 1 ? "A personal connection was" : `${personal.length} personal connections were`} unselected: an org sandbox only gets org connections.`,
    );
  }

  function toggle(connectionId: string, on: boolean) {
    setChosen(on ? [...chosen, connectionId] : chosen.filter((item) => item !== connectionId));
  }

  const personal = list.filter((item) => item.scope === "personal");
  const shared = list.filter((item) => item.scope === "org");

  return (
    <div ref={group} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Who sees the sandbox</legend>
        <input type="hidden" name="visibility" value={visibility} />
        <div className="grid gap-2 sm:grid-cols-2">
          <ChoiceCard
            name={`${idPrefix}-visibility`}
            checked={visibility === "private"}
            onChange={() => choose("private")}
            icon={<LockIcon />}
            title="Private"
            hint="Only you."
          />
          <ChoiceCard
            name={`${idPrefix}-visibility`}
            checked={visibility === "org"}
            onChange={() => choose("org")}
            disabled={goldenVisibility === "private"}
            icon={<GlobeIcon />}
            title="Org"
            hint={goldenVisibility === "private" ? "Not for a private golden." : "Every member can open and stop it."}
          />
        </div>
      </fieldset>

      <fieldset
        className="space-y-2"
        aria-describedby={visibility === "org" ? `${idPrefix}-connections-hint` : undefined}
      >
        <legend className="text-sm font-medium">MCP connections</legend>
        {visibility === "org" && (
          <p id={`${idPrefix}-connections-hint`} className="text-xs text-muted-foreground">
            Org connections only. Choose Private to use your own.
          </p>
        )}
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
                        blocker={launchBlocker(connection, visibility)}
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
        <p role="status" className="text-xs text-warning">
          {notice}
        </p>
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
