"use client";

import type { Harness, SandboxProviderId } from "@armada/core";
import { ChevronDownIcon, CircleAlertIcon, RocketIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { launchFromGolden } from "@/app/actions/sandboxes";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ConnectionStatusBadge } from "@/components/connections";
import { EFFORT_LABEL, type ModelCatalog, ModelFields } from "@/components/model-fields";
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

type LaunchProps = {
  golden: string;
  provider: SandboxProviderId;
  orgId: string;
  catalog: ModelCatalog;
  goldenVisibility: SandboxVisibility;
  connections: LaunchConnections;
  /** The golden config's `repos[].dir`, in order. */
  repositories: readonly string[];
};

/**
 * Launches an agent from a golden. The task comes first, then the agent and, for a golden with several
 * repositories, the project. Everything else starts on its configured default and is summarized on the collapsed
 * Advanced area, where it can be overridden.
 */
export function LaunchDialog(props: LaunchProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" aria-label={`Launch from ${props.golden} on ${PROVIDER_LABELS[props.provider]}`}>
          <RocketIcon /> Launch
        </Button>
      </DialogTrigger>
      {/* Header and footer stay put; only the fields scroll, so Launch is always on screen. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0">
        <LaunchForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted with the dialog, so every opening starts from the defaults. */
function LaunchForm({ golden, provider, orgId, catalog, goldenVisibility, connections, repositories }: LaunchProps) {
  const id = useId();
  const [harness, setHarness] = useState<Harness>("claude");
  const [choice, setChoice] = useState({
    model: catalog.claude.defaultModel,
    effort: catalog.claude.defaultReasoningEffort,
  });
  const access = useLaunchAccess(goldenVisibility, connections);
  const root = useRef<HTMLDivElement>(null);
  const advanced = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const node = root.current;
    const details = advanced.current;
    if (!node || !details) return;
    // React resets a form after its action returns. A failed launch must keep the task and the choices that were
    // made, so the person fixes the cause and launches again; a successful one navigates away.
    const keep = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    // A field the browser refuses to submit (an empty custom model id) must be visible to be focused and explained.
    const reveal = () => {
      details.open = true;
    };
    node.addEventListener("reset", keep, true);
    details.addEventListener("invalid", reveal, true);
    return () => {
      node.removeEventListener("reset", keep, true);
      details.removeEventListener("invalid", reveal, true);
    };
  }, []);

  // Going on without an unready default enables Launch: that is the next step, so focus follows.
  const focusLaunch = useRef(false);
  useEffect(() => {
    if (!focusLaunch.current || access.held) return;
    focusLaunch.current = false;
    root.current?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
  }, [access.held]);

  const [project, setProject] = useState(repositories.length === 1 ? (repositories[0] ?? "") : "");
  const onChoice = useCallback((next: { model: string; effort: string }) => setChoice(next), []);
  const entry = catalog[harness];
  const modelLabel = entry.models.find((option) => option.id === choice.model)?.label ?? (choice.model || "Model id");
  const summary = [
    modelLabel,
    EFFORT_LABEL[choice.effort] ?? choice.effort,
    // A single repository is chosen in Advanced, so its choice is summarized with the other overrides.
    repositories.length === 1 ? project || "Default directory" : null,
    access.visibility === "org" ? "Org" : "Private",
    mcpFact(access),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <DialogHeader className="px-6 pt-6 pb-4 pr-12">
        <DialogTitle className="truncate">Launch from {golden}</DialogTitle>
        <DialogDescription>On {PROVIDER_LABELS[provider]}</DialogDescription>
      </DialogHeader>
      <ActionForm
        action={launchFromGolden}
        className="flex min-h-0 flex-1 flex-col"
        focusError
        footerClassName="space-y-2 border-t px-6 py-4"
        footer={
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            {access.held && (
              <p id={`${id}-held`} className="mr-auto text-xs text-warning">
                Decide on the MCP default first.
              </p>
            )}
            {/* Only set when held: SubmitButton's own pending lock must not be overridden by `disabled={false}`. */}
            <SubmitButton
              className="w-full sm:w-auto"
              {...(access.held ? { disabled: true, "aria-describedby": `${id}-held` } : {})}
            >
              <RocketIcon /> Launch
            </SubmitButton>
          </div>
        }
      >
        <input type="hidden" name="golden" value={golden} />
        <input type="hidden" name="provider" value={provider} />
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="visibility" value={access.visibility} />
        <div data-launch-fields className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 pb-4">
          <div className="space-y-2 pt-1">
            <Label htmlFor={`${id}-prompt`}>Task</Label>
            <Textarea
              id={`${id}-prompt`}
              name="prompt"
              rows={4}
              className="max-h-[40dvh] min-h-24"
              placeholder="What should the agent do? Leave empty to start idle."
            />
          </div>
          <div className={cn("grid gap-4", repositories.length > 1 && "sm:grid-cols-2")}>
            <Segmented
              legend="Agent"
              name="harness"
              value={harness}
              onChange={setHarness}
              options={(Object.keys(catalog) as Harness[]).map((value) => ({ value, label: HARNESS_LABELS[value] }))}
            />
            {repositories.length > 1 && <RepositoryField idPrefix={id} repositories={repositories} />}
          </div>
          {access.alerts(() => {
            focusLaunch.current = true;
          })}
          <details ref={advanced} data-launch-advanced className="group rounded-md border">
            {/* On a phone the summary wraps under the label: every default stays readable, none is cut off. */}
            <summary className="flex cursor-pointer list-none items-center gap-3 rounded-md px-3 py-2.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
                <span className="font-medium">Advanced</span>
                <span data-launch-summary className="min-w-0 text-xs text-muted-foreground sm:flex-1 sm:text-right">
                  {summary}
                </span>
              </span>
              <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="space-y-4 border-t p-3">
              <ModelFields key={harness} idPrefix={id} harness={harness} catalog={catalog} onChoice={onChoice} />
              {repositories.length === 1 && (
                <RepositoryField idPrefix={id} repositories={repositories} onChange={setProject} />
              )}
              {access.fields(id)}
            </div>
          </details>
        </div>
      </ActionForm>
    </div>
  );
}

/** A compact radio group: every option visible, one choice, arrow keys move between them. */
function Segmented<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  hint,
}: {
  legend: string;
  name: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  hint?: { id: string; text: string };
}) {
  return (
    <fieldset className="min-w-0 space-y-2" aria-describedby={hint?.id}>
      <legend className="text-sm leading-none font-medium">{legend}</legend>
      <div className="grid h-9 auto-cols-fr grid-flow-col gap-0.5 rounded-md border border-input p-0.5 dark:bg-input/30">
        {options.map((option) => (
          <label
            key={option.value}
            className="relative flex min-w-0 cursor-pointer items-center justify-center rounded-sm px-2 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground has-[:checked]:bg-accent has-[:checked]:font-medium has-[:checked]:text-foreground has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
              className="absolute inset-0 size-full cursor-pointer appearance-none rounded-sm opacity-0 disabled:cursor-not-allowed"
            />
            {option.label}
          </label>
        ))}
      </div>
      {hint && (
        <p id={hint.id} className="text-xs text-muted-foreground">
          {hint.text}
        </p>
      )}
    </fieldset>
  );
}

/**
 * The configured checkout the agent starts in. A golden with one repository starts there; with several, in the
 * default directory until one is chosen. Every repository stays available either way.
 */
function RepositoryField({
  idPrefix,
  repositories,
  onChange,
}: {
  idPrefix: string;
  repositories: readonly string[];
  onChange?: (dir: string) => void;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={`${idPrefix}-repo`}>Project</Label>
      <NativeSelect
        id={`${idPrefix}-repo`}
        name="repo"
        defaultValue={repositories.length === 1 ? repositories[0] : ""}
        onChange={(event) => onChange?.(event.target.value)}
      >
        <option value="">Default directory</option>
        {repositories.map((dir) => (
          <option key={dir} value={dir}>
            {dir}
          </option>
        ))}
      </NativeSelect>
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
 *
 * The alerts render outside the collapsed Advanced area, so nothing that holds or limits a launch is hidden.
 */
function useLaunchAccess(goldenVisibility: SandboxVisibility, connections: LaunchConnections) {
  const [visibility, setVisibility] = useState<SandboxVisibility>(goldenVisibility);
  // Null until the person changes the selection: the defaults for the current visibility apply until then.
  const [picked, setPicked] = useState<string[] | null>(null);
  // A requested default that is not connected holds the launch until the person reconnects it or explicitly goes
  // on without it. Ticking other connections does not count: it would drop the default without saying so.
  // By id, so a default that only becomes eligible later (switching to Private) is held again, not waived unseen.
  const [waived, setWaived] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState("");
  const list = "connections" in connections ? connections.connections : [];
  const chosen = picked ?? launchDefaults(list, visibility);
  const unready = unreadyDefaults(list, visibility).filter((connection) => !waived.includes(connection.id));

  function choose(next: SandboxVisibility) {
    setVisibility(next);
    if (next !== "org" || picked === null) return setNotice("");
    const personal = chosen.filter((item) => list.find((connection) => connection.id === item)?.scope === "personal");
    if (personal.length === 0) return setNotice("");
    setPicked(chosen.filter((item) => !personal.includes(item)));
    setNotice(
      `${personal.length === 1 ? "A personal connection was" : `${personal.length} personal connections were`} unselected: an org sandbox only gets org connections.`,
    );
  }

  function toggle(connectionId: string, on: boolean) {
    setPicked(on ? [...chosen, connectionId] : chosen.filter((item) => item !== connectionId));
  }

  const selected = list.filter(
    (connection) => chosen.includes(connection.id) && launchBlocker(connection, visibility) === null,
  ).length;

  const alerts = (onContinue: () => void): ReactNode => (
    <>
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
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => {
              setWaived([...waived, ...unready.map((connection) => connection.id)]);
              setPicked(chosen);
              onContinue();
            }}
          >
            Continue without {unready.length === 1 ? "it" : "them"}
          </Button>
        </div>
      )}
      {"unavailable" in connections && (
        <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
          Connections could not be loaded: {connections.unavailable} You can still launch without them.
        </p>
      )}
    </>
  );

  const fields = (idPrefix: string): ReactNode => {
    const personal = list.filter((item) => item.scope === "personal");
    const shared = list.filter((item) => item.scope === "org");
    return (
      <>
        <Segmented
          legend="Access"
          name={`${idPrefix}-visibility`}
          value={visibility}
          onChange={choose}
          options={[
            { value: "org", label: "Org", disabled: goldenVisibility === "private" },
            { value: "private", label: "Private" },
          ]}
          hint={{
            id: `${idPrefix}-visibility-hint`,
            text: accessHint(visibility, goldenVisibility),
          }}
        />
        {"connections" in connections && (
          <fieldset className="min-w-0 space-y-2">
            <legend className="text-sm leading-none font-medium">MCP connections</legend>
            {list.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                No connections.{" "}
                <Link href="/connections" className="underline">
                  Add one
                </Link>
              </p>
            ) : (
              <div className="space-y-3">
                {(
                  [
                    ["Personal", personal],
                    ["Org", shared],
                  ] as const
                ).map(([title, items]) =>
                  items.length === 0 ? null : (
                    <div key={title} className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">{title}</p>
                      <ul className="divide-y rounded-md border">
                        {items.map((connection) => (
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
            <p role="status" className="text-xs text-warning empty:hidden">
              {notice}
            </p>
          </fieldset>
        )}
      </>
    );
  };

  return {
    visibility,
    selected,
    held: unready.length > 0,
    unavailable: "unavailable" in connections,
    alerts,
    fields,
  };
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
  const hint =
    blocker ??
    [
      connection.accountLabel ? `As ${connection.accountLabel}` : null,
      connection.transport === "stdio"
        ? "Starts inside the sandbox"
        : connection.toolCount !== undefined
          ? `${connection.toolCount} tools`
          : null,
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <li className={cn("flex items-start gap-3 px-3 py-2.5", blocker && "opacity-70")}>
      <input
        id={inputId}
        type="checkbox"
        name="connections"
        value={connection.id}
        checked={checked && !blocker}
        disabled={blocker !== null}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={hint ? `${inputId}-hint` : undefined}
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
        {hint && (
          <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
    </li>
  );
}

/** What the chosen access means; a private golden says why Org is not offered. */
function accessHint(visibility: SandboxVisibility, goldenVisibility: SandboxVisibility): string {
  if (visibility === "org") return "Org members can open and stop it.";
  return goldenVisibility === "private" ? "Only you: a private golden launches private sandboxes." : "Only you.";
}

/** The MCP connections a launch gets, as one summary fact. */
function mcpFact(access: { unavailable: boolean; selected: number }): string {
  if (access.unavailable) return "MCP unavailable";
  return access.selected === 0 ? "No MCP" : `${access.selected} MCP`;
}
