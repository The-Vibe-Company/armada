"use client";

import type { Harness, MachineSize, MachineSizePolicy, SandboxProviderId } from "@armada/core";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  CpuIcon,
  FolderIcon,
  GaugeIcon,
  PlugIcon,
  RocketIcon,
  ServerIcon,
  WalletIcon,
} from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode, type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import { launchFromGolden } from "@/app/actions/sandboxes";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ConnectionStatusBadge } from "@/components/connections";
import { MachineSizeField } from "@/components/machine-size-field";
import { ModKey } from "@/components/mod-key";
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
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  CONNECTION_CHOICE_FIELD,
  launchBlocker,
  launchDefaults,
  type McpConnection,
  unreadyDefaults,
} from "@/lib/connections";
import { PROVIDER_LABELS } from "@/lib/golden-form";
import { HARNESS_LABELS } from "@/lib/labels";
import { MACHINE_SIZE_LABELS } from "@/lib/machine-size";
import {
  accountProblem,
  accountsFor,
  HARNESS_PATH,
  kindNote,
  type LaunchAccounts,
  launchDefault,
  type ModelAccount,
} from "@/lib/model-accounts";
import { isSubmitShortcut } from "@/lib/shortcut";
import { cn } from "@/lib/utils";

/** The selected org's connections for the launch dialog, or why they are not listed. */
export type LaunchConnections = { connections: McpConnection[] } | { unavailable: string };

/**
 * The golden's machine size policy (`@armada/core` contract version 1), `null` when none is set. Absent while the
 * server cannot take a size for this launch: the dialog then shows no size and launches as before.
 */
export type LaunchSizing = { policy: MachineSizePolicy | null };

type LaunchProps = {
  golden: string;
  provider: SandboxProviderId;
  orgId: string;
  catalog: ModelCatalog;
  connections: LaunchConnections;
  /** The model accounts the viewer may launch with, or why none are listed. */
  accounts: LaunchAccounts;
  /** The golden config's `repos[].dir`, in order. */
  repositories: readonly string[];
  sizing?: LaunchSizing;
};

/**
 * Launches an agent from a golden. The task comes first, then the agent and, for a golden with several
 * repositories, the project. Everything else starts on its configured default and is summarized on the collapsed
 * Advanced area, where it can be overridden. Who may open the sandbox is not a choice: its owner and the org's
 * admins (#680).
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
function LaunchForm({ golden, provider, orgId, catalog, connections, accounts, repositories, sizing }: LaunchProps) {
  const id = useId();
  const [harness, setHarness] = useState<Harness>("claude");
  const [choice, setChoice] = useState({
    model: catalog.claude.defaultModel,
    effort: catalog.claude.defaultReasoningEffort,
  });
  const access = useLaunchAccess(connections);
  const root = useRef<HTMLDivElement>(null);
  const advanced = useRef<HTMLDetailsElement>(null);
  useVisibleViewport(root);

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
    // ⌘↵ launches from any field, as the composer sends. It goes through the Launch button, so a held or pending
    // launch (the button is disabled) is not submitted by the keyboard either.
    const shortcut = (event: KeyboardEvent) => {
      if (!isSubmitShortcut(event)) return;
      event.preventDefault();
      const button = node.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (button && !button.disabled) button.form?.requestSubmit(button);
    };
    node.addEventListener("reset", keep, true);
    node.addEventListener("keydown", shortcut);
    details.addEventListener("invalid", reveal, true);
    return () => {
      node.removeEventListener("reset", keep, true);
      node.removeEventListener("keydown", shortcut);
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

  // The selected project: the machine size default follows it, and a single repository's choice is summarized.
  const [project, setProject] = useState(repositories.length === 1 ? (repositories[0] ?? "") : "");
  // The size that will be requested, null while the provider decides.
  const [size, setSize] = useState<MachineSize | null>(null);
  const onChoice = useCallback((next: { model: string; effort: string }) => setChoice(next), []);
  const entry = catalog[harness];
  const modelLabel = entry.models.find((option) => option.id === choice.model)?.label ?? (choice.model || "Model id");
  const summary: { key: string; icon: ReactNode; text: string }[] = [
    { key: "model", icon: <CpuIcon />, text: modelLabel },
    { key: "effort", icon: <GaugeIcon />, text: EFFORT_LABEL[choice.effort] ?? choice.effort },
    // A single repository is chosen in Advanced, so its choice is summarized with the other overrides.
    ...(repositories.length === 1
      ? [{ key: "project", icon: <FolderIcon />, text: project || "Default directory" }]
      : []),
    ...(sizing ? [{ key: "size", icon: <ServerIcon />, text: sizeFact(size) }] : []),
    { key: "mcp", icon: <PlugIcon />, text: mcpFact(access) },
  ];

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
              <LaunchShortcut />
            </SubmitButton>
          </div>
        }
      >
        <input type="hidden" name="golden" value={golden} />
        <input type="hidden" name="provider" value={provider} />
        <input type="hidden" name="org" value={orgId} />
        {/* Untouched, or not listed: the launch names no connections and the server applies the defaults (#681). */}
        <input type="hidden" name={CONNECTION_CHOICE_FIELD} value={access.explicit ? "explicit" : "defaults"} />
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
            {repositories.length > 1 && (
              <RepositoryField idPrefix={id} repositories={repositories} onChange={setProject} />
            )}
          </div>
          {/* Who is billed stays in view: it is never a collapsed default. */}
          <AccountField key={harness} idPrefix={id} harness={harness} accounts={accounts} />
          {access.alerts(() => {
            focusLaunch.current = true;
          })}
          <details ref={advanced} data-launch-advanced className="group rounded-md border">
            {/* On a phone the summary wraps under the label: every default stays readable, none is cut off. */}
            <summary className="flex cursor-pointer list-none items-center gap-3 rounded-md px-3 py-2.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
                <span className="font-medium">Advanced</span>
                {/* Each default is its own chip; the hidden separators keep it one sentence when read aloud. */}
                <span
                  data-launch-summary
                  className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground sm:flex-1 sm:justify-end"
                >
                  {summary.map((fact, index) => (
                    <Fragment key={fact.key}>
                      {index > 0 && <span className="sr-only"> · </span>}
                      <span
                        data-launch-fact={fact.key}
                        className="inline-flex max-w-full items-center gap-1 rounded-full border bg-background px-2 py-0.5 dark:bg-input/30 [&_svg]:size-3 [&_svg]:shrink-0"
                      >
                        <span aria-hidden="true" className="contents">
                          {fact.icon}
                        </span>
                        <span className="truncate">{fact.text}</span>
                      </span>
                    </Fragment>
                  ))}
                </span>
              </span>
              <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="space-y-4 border-t p-3">
              <ModelFields key={harness} idPrefix={id} harness={harness} catalog={catalog} onChoice={onChoice} />
              {repositories.length === 1 && (
                <RepositoryField idPrefix={id} repositories={repositories} onChange={setProject} />
              )}
              {sizing && (
                <MachineSizeField
                  idPrefix={id}
                  provider={provider}
                  policy={sizing.policy}
                  repositoryDir={project}
                  onSize={setSize}
                />
              )}
              {access.fields(id)}
            </div>
          </details>
        </div>
      </ActionForm>
    </div>
  );
}

/**
 * Keeps the dialog inside what the phone actually shows. An on-screen keyboard shrinks the visual viewport, while
 * `dvh` (iOS) still measures the layout viewport, so a centered dialog would put Launch under the keyboard. While
 * part of the layout viewport is hidden, the dialog is centered in the visible part and capped to its height, and
 * the focused field is scrolled into the fields' own region. Nothing changes while the whole viewport is visible.
 */
function useVisibleViewport(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const viewport = window.visualViewport;
    const content = root.current?.closest<HTMLElement>('[data-slot="dialog-content"]');
    const fields = root.current?.querySelector<HTMLElement>("[data-launch-fields]");
    if (!viewport || !content || !fields) return;
    const release = () => {
      content.style.removeProperty("top");
      content.style.removeProperty("max-height");
      content.style.removeProperty("transition-property");
      delete content.dataset.visibleViewport;
    };
    const fit = () => {
      // A pinch zoom also shrinks the visual viewport; only a keyboard does so at scale 1.
      if (viewport.scale > 1 || (window.innerHeight - viewport.height < 1 && viewport.offsetTop < 1)) return release();
      // No easing: the bounds apply now, so the focused field below is measured where it will stay.
      content.style.transitionProperty = "none";
      content.style.top = `${viewport.offsetTop + viewport.height / 2}px`;
      content.style.maxHeight = `${Math.max(viewport.height - 16, 0)}px`;
      content.dataset.visibleViewport = "";
      // Only the fields scroll: bring the focused one into their region, never the page behind the dialog.
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !fields.contains(active)) return;
      const box = active.getBoundingClientRect();
      const region = fields.getBoundingClientRect();
      if (box.bottom > region.bottom) fields.scrollTop += Math.min(box.bottom - region.bottom, box.top - region.top);
      else if (box.top < region.top) fields.scrollTop -= region.top - box.top;
    };
    fit();
    viewport.addEventListener("resize", fit);
    viewport.addEventListener("scroll", fit);
    fields.addEventListener("focusin", fit);
    return () => {
      viewport.removeEventListener("resize", fit);
      viewport.removeEventListener("scroll", fit);
      fields.removeEventListener("focusin", fit);
      release();
    };
  }, [root]);
}

/**
 * Which account the agent runs on, and so who is billed. The resolved default is preselected and sent as an
 * explicit id, so what the person saw is what runs; with several accounts and no default the person chooses.
 * The sandbox keeps this account for every later message, whatever the defaults become. The launch form is never
 * reset after a refused launch, so a retry bills the account the person picked.
 */
function AccountField({
  idPrefix,
  harness,
  accounts,
}: {
  idPrefix: string;
  harness: Harness;
  accounts: LaunchAccounts;
}) {
  const label = HARNESS_LABELS[harness];
  if (accounts.state === "legacy") return null;
  if (accounts.state === "unavailable")
    return (
      <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
        Model accounts could not be loaded: {accounts.reason} Reload to launch with a chosen account.
      </p>
    );
  const compatible = accountsFor(accounts.accounts, harness);
  if (compatible.length === 0)
    return (
      <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-account-field="none">
        No {label} account.{" "}
        <Link href={HARNESS_PATH} className="underline">
          Add one
        </Link>
      </p>
    );
  const resolved = launchDefault(accounts.accounts, harness, accounts.now);
  const preset = resolved.state === "resolved" ? resolved.account.id : "";
  const groups: [string, ModelAccount[]][] = [
    ["Yours", compatible.filter((account) => account.scope === "user")],
    [accounts.orgName, compatible.filter((account) => account.scope === "org")],
  ];
  return (
    // Its own row, apart from the run settings: the choice of who pays is read before Launch, never assumed.
    <div data-account-row className="flex gap-3 rounded-lg border bg-muted/40 p-3 dark:bg-input/20">
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground shadow-xs [&_svg]:size-4"
      >
        <WalletIcon />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-account`}>Account</Label>
          <p
            id={`${idPrefix}-account-hint`}
            className={cn(
              "text-xs text-pretty",
              resolved.state === "unusable" ? "text-warning" : "text-muted-foreground",
            )}
            data-account-field={resolved.state}
          >
            {resolved.state === "unusable"
              ? `${resolved.account.name} would be used, but it is ${accountProblem(resolved.account, accounts.now)}. Choose another account.`
              : resolved.state === "ambiguous"
                ? "No default for this agent: choose who is billed."
                : "Billed for this sandbox, now and for every later message."}
          </p>
        </div>
        <NativeSelect
          id={`${idPrefix}-account`}
          name="credential"
          defaultValue={preset}
          required
          aria-describedby={`${idPrefix}-account-hint`}
          className="w-full bg-background"
        >
          {preset === "" && (
            <option value="" disabled>
              Choose an account
            </option>
          )}
          {groups.map(([group, rows]) =>
            rows.length === 0 ? null : (
              <optgroup key={group} label={group}>
                {rows.map((account) => (
                  <option key={account.id} value={account.id} disabled={accountProblem(account, accounts.now) !== null}>
                    {optionLabel(account, accounts.now, accounts.orgName)}
                  </option>
                ))}
              </optgroup>
            ),
          )}
        </NativeSelect>
      </div>
    </div>
  );
}

/** The shortcut Launch answers to, on the button itself; hidden from its accessible name. */
function LaunchShortcut() {
  return (
    <Kbd
      aria-hidden="true"
      className="-mr-1 ml-0.5 border-transparent bg-primary-foreground/15 text-primary-foreground/80 shadow-none max-sm:hidden"
    >
      <span>
        <ModKey />
      </span>
      <span>↵</span>
    </Kbd>
  );
}

/**
 * "Work (Claude subscription, default)": the name, then only the notes that add something. An org account names
 * its org, so the closed select still says who is billed when a personal and an org account share a name.
 */
function optionLabel(account: ModelAccount, now: number, orgName: string): string {
  const owner = account.scope === "org" ? orgName : null;
  const notes = [owner, kindNote(account), account.isDefault ? "default" : null, accountProblem(account, now)].filter(
    Boolean,
  );
  return notes.length ? `${account.name} (${notes.join(", ")})` : account.name;
}

/** A compact radio group: every option visible, one choice, arrow keys move between them. */
function Segmented<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="min-w-0 space-y-2">
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
              onChange={() => onChange(option.value)}
              className="absolute inset-0 size-full cursor-pointer appearance-none rounded-sm opacity-0 disabled:cursor-not-allowed"
            />
            {option.label}
          </label>
        ))}
      </div>
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
 * Connections, by the #681 selection. It starts with every enabled include-by-default connection, personal and org,
 * whatever the golden; from the person's first change it is exactly what they ticked, and an empty selection launches
 * with none. A default that is not connected is never dropped silently: it holds the launch until it is reconnected
 * or the person chooses to continue without it, as the server does.
 *
 * The alerts render outside the collapsed Advanced area, so nothing that holds or limits a launch is hidden.
 */
function useLaunchAccess(connections: LaunchConnections) {
  // Null until the person changes the selection: the defaults apply until then.
  const [picked, setPicked] = useState<string[] | null>(null);
  // A requested default that is not connected holds the launch until the person reconnects it or explicitly goes
  // on without it. Ticking other connections does not count: it would drop the default without saying so.
  const [waived, setWaived] = useState<readonly string[]>([]);
  const list = "connections" in connections ? connections.connections : [];
  const blocked = unreadyDefaults(list);
  // A default that is not connected cannot be ticked: it is held rather than submitted or dropped unseen.
  const chosen = picked ?? launchDefaults(list).filter((item) => !blocked.some((connection) => connection.id === item));
  const unready = blocked.filter((connection) => !waived.includes(connection.id));

  function toggle(connectionId: string, on: boolean) {
    setPicked(on ? [...chosen, connectionId] : chosen.filter((item) => item !== connectionId));
  }

  const selected = list.filter(
    (connection) => chosen.includes(connection.id) && launchBlocker(connection) === null,
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
            <Link href="/tools" className="underline">
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
          Connections could not be loaded: {connections.unavailable} A launch uses your default connections, and is
          refused if one of them is not connected.
        </p>
      )}
    </>
  );

  const fields = (idPrefix: string): ReactNode => {
    const personal = list.filter((item) => item.scope === "personal");
    const shared = list.filter((item) => item.scope === "org");
    return (
      <>
        {"connections" in connections && (
          <fieldset className="min-w-0 space-y-2">
            <legend className="text-sm leading-none font-medium">MCP connections</legend>
            {list.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                No connections.{" "}
                <Link href="/tools" className="underline">
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
        )}
      </>
    );
  };

  return {
    // Only a listed selection the person changed is sent; otherwise the server snapshots the defaults.
    explicit: picked !== null && "connections" in connections,
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

/** The MCP connections a launch gets, as one summary fact. */
function mcpFact(access: { unavailable: boolean; selected: number }): string {
  if (access.unavailable) return "MCP unavailable";
  return access.selected === 0 ? "No MCP" : `${access.selected} MCP`;
}

/** The machine size a launch requests, as one summary fact named apart from effort; without one the provider decides. */
function sizeFact(size: MachineSize | null): string {
  return `${size ? MACHINE_SIZE_LABELS[size] : "Default"} machine`;
}
