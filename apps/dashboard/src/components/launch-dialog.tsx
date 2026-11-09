"use client";

import type { Harness, SandboxProviderId } from "@armada/core";
import { GlobeIcon, LockIcon, RocketIcon } from "lucide-react";
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
import { launchBlocker, type McpConnection, type SandboxVisibility } from "@/lib/connections";
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
          <DialogDescription>
            The model and reasoning effort apply to the first prompt and to every later message.
          </DialogDescription>
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
          <AccessFields idPrefix={id} goldenVisibility={goldenVisibility} connections={connections} />
          <div className="space-y-2">
            <Label htmlFor={`${id}-prompt`}>First prompt</Label>
            <Textarea
              id={`${id}-prompt`}
              name="prompt"
              rows={4}
              placeholder="Optional. Leave empty for a sandbox that waits for the first message."
            />
          </div>
          <SubmitButton>Launch</SubmitButton>
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
          ? "This golden records no repository, so the agent starts in the default directory."
          : "A chosen repository is where the agent starts; with none, it starts in the default directory. All repositories remain available."}
      </p>
    </div>
  );
}

/**
 * Visibility and connections. A personal connection carries its owner's identity, so it can only go into a
 * private sandbox: it is not selectable while Org is chosen, and choosing Org drops it from the selection.
 */
function AccessFields({
  idPrefix,
  goldenVisibility,
  connections,
}: {
  idPrefix: string;
  goldenVisibility: SandboxVisibility;
  connections: LaunchConnections;
}) {
  const [visibility, setVisibility] = useState<SandboxVisibility>(goldenVisibility);
  const [chosen, setChosen] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const group = useRef<HTMLDivElement>(null);
  const list = "connections" in connections ? connections.connections : [];

  // Native reset after a launch attempt empties the DOM; the controlled state must follow it.
  useEffect(() => {
    const form = group.current?.closest("form");
    const reset = () => {
      setVisibility(goldenVisibility);
      setChosen([]);
      setNotice("");
    };
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, [goldenVisibility]);

  function choose(next: SandboxVisibility) {
    setVisibility(next);
    if (next !== "org") return setNotice("");
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
            hint={
              goldenVisibility === "org" ? "Only you, even though the golden is shared." : "Only you, like the golden."
            }
          />
          <ChoiceCard
            name={`${idPrefix}-visibility`}
            checked={visibility === "org"}
            onChange={() => choose("org")}
            disabled={goldenVisibility === "private"}
            icon={<GlobeIcon />}
            title="Org"
            hint={
              goldenVisibility === "private"
                ? "Not for a private golden."
                : "Every member can follow, message and stop it."
            }
          />
        </div>
      </fieldset>

      <fieldset className="space-y-2" aria-describedby={`${idPrefix}-connections-hint`}>
        <legend className="text-sm font-medium">MCP connections</legend>
        <p id={`${idPrefix}-connections-hint`} className="text-xs text-muted-foreground">
          {visibility === "org"
            ? "An org sandbox only gets connections an admin shared with the org. Choose Private to use your own."
            : "The agent gets the tools, resources and prompts of the servers you pick."}
        </p>
        {"unavailable" in connections ? (
          <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
            Connections could not be loaded: {connections.unavailable} You can still launch without them.
          </p>
        ) : list.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            No connections yet.{" "}
            <Link href="/connections" className="underline">
              Add one
            </Link>{" "}
            to give agents MCP servers.
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
