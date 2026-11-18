"use client";

import type { Harness, MachineSizePolicy, SandboxPlacementProviderId } from "@armada/core";
import { MODEL_CATALOG, SANDBOX_PLACEMENT_LABELS as PROVIDER_LABELS } from "@armada/core";
import { CircleAlertIcon, RocketIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { launchFromDockerSnapshot } from "@/app/actions/docker-snapshots";
import { launchFromGolden, readLaunchDialogOptions } from "@/app/actions/sandboxes";
import { ActionForm } from "@/components/action-form";
import { ConnectionStatusBadge } from "@/components/connections";
import { DockerLaunchForm } from "@/components/docker-launch";
import { ComposerLocation, ComposerStop, DockerLimits, LaunchChip, LaunchComposer } from "@/components/launch-composer";
import { LaunchAccountNotice, LaunchSentence } from "@/components/launch-sentence";
import { LaunchDialogContent } from "@/components/launch-surface";
import { MachineSizeField } from "@/components/machine-size-field";
import type { ModelCatalog } from "@/components/model-fields";
import { SkillPicker } from "@/components/skill-picker";
import { TemplateLaunchForm } from "@/components/templates";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  CONNECTION_CHOICE_FIELD,
  launchBlocker,
  launchDefaults,
  type McpConnection,
  unreadyDefaults,
} from "@/lib/connections";
import { DOCKER_HOST_LABEL, dockerHostGroup } from "@/lib/labels";
import { composerChips, launchHoldIds, launchToolsSummary } from "@/lib/launch-composer";
import { LAUNCH_KEY_FIELD, type LaunchKey, launchKeyFor } from "@/lib/launch-key";
import { initialLaunchSelection, type LaunchStartTarget } from "@/lib/launch-picker";
import { accountProblem, accountsFor, type LaunchAccounts } from "@/lib/model-accounts";
import type { TemplateLaunchTarget } from "@/lib/template-launch";
import { cn } from "@/lib/utils";

/** The selected org's connections for the launch dialog, or why they are not listed. */
export type LaunchConnections = { connections: McpConnection[] } | { unavailable: string };

/**
 * The golden's machine size policy (`@armada/core` contract version 1), `null` when none is set. Absent while the
 * server cannot take a size for this launch: the dialog then shows no size and launches as before.
 */
export type LaunchSizing = { policy: MachineSizePolicy | null };

export type LaunchProps = {
  golden: string;
  provider: SandboxPlacementProviderId;
  snapshotId?: string;
  hostName?: string;
  unavailable?: readonly { name: string; reason: string }[] | undefined;
  dockerLimits?: ReactNode;
  harnesses?: readonly Harness[] | undefined;
  boatOpenCodeAvailable?: boolean;
  orgId: string;
  catalog: ModelCatalog;
  connections: LaunchConnections;
  /** The model accounts the viewer may launch with, or why none are listed. */
  accounts: LaunchAccounts;
  /** The golden config's `repos[].dir`, in order. */
  repositories: readonly string[];
  sizing?: LaunchSizing;
  /** The templates that start from this environment: choosing one preselects everything but the run (#949). */
  templates?: readonly TemplateLaunchTarget[];
  starts?: readonly LaunchStartTarget[];
  selectedStart?: string;
  onStart?: (id: string) => void;
  idleDelaySeconds?: number | undefined;
  templateChooser?: ReactNode;
  launchBlockedReason?: string | undefined;
  loadingError?: string;
  task?: string;
  onTask?: (value: string) => void;
};

/**
 * Launches an agent from a golden. The task comes first, then the agent and, for a golden with several
 * repositories, the project. Account and model choices stay visible; optional skills and infrastructure overrides
 * stay in Advanced. Who may open the sandbox is not a choice: its owner and the org's
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
      <LaunchDialogContent>
        <LaunchStart {...props} />
      </LaunchDialogContent>
    </Dialog>
  );
}

/**
 * With templates for this environment, the dialog starts with a choice: everything chosen here, or a template's
 * preset (its agent, model, tools and variables), where only the task and the run remain to choose.
 */
export type HostLaunchStart = {
  orgId: string;
  hostId: string;
  hostName: string;
  accounts: LaunchAccounts;
  unavailable?: readonly { name: string; reason: string }[] | undefined;
  dockerLimits?: ReactNode;
  harnesses: Harness[];
  initialHarness: Harness;
};

export function LaunchStart(
  props: (LaunchProps | HostLaunchStart) & {
    initialOptions?: Awaited<ReturnType<typeof readLaunchDialogOptions>>;
  },
) {
  const [options, setOptions] = useState<Awaited<ReturnType<typeof readLaunchDialogOptions>> | null>(null);
  const [loadingError, setLoadingError] = useState("");
  const host = "hostId" in props;
  const fallback: LaunchStartTarget = host
    ? {
        id: `host:${props.hostId}`,
        label: `Empty machine · ${props.hostName}`,
        group: dockerHostGroup(props.hostName),
        hostName: props.hostName,
        golden: "",
        provider: "docker",
        hostId: props.hostId,
        repositories: [],
        harnesses: props.harnesses,
        initialHarness: props.initialHarness,
      }
    : {
        id: props.snapshotId ? `snapshot:${props.snapshotId}` : `${props.provider}:${props.golden}`,
        label: `${props.golden} · ${props.provider === "boat" ? "Boat cloud" : props.provider === "modal" ? "Modal cloud" : DOCKER_HOST_LABEL}`,
        group: props.provider === "docker" ? DOCKER_HOST_LABEL : `${PROVIDER_LABELS[props.provider]} cloud`,
        golden: props.golden,
        provider: props.provider,
        repositories: props.repositories,
        ...(props.snapshotId ? { snapshotId: props.snapshotId } : {}),
        ...(props.hostName ? { hostName: props.hostName } : {}),
        ...(props.harnesses ? { harnesses: [...props.harnesses] } : {}),
        ...(props.sizing ? { sizing: props.sizing } : {}),
      };
  const [selected, setSelected] = useState(fallback.id);
  const selectedTarget = useRef(fallback);
  const startRoot = useRef<HTMLDivElement>(null);
  const focusStart = useRef(false);
  useLayoutEffect(() => {
    if (!focusStart.current) return;
    focusStart.current = false;
    startRoot.current?.querySelector<HTMLButtonElement>('[data-launch-chip="From"]')?.focus();
  });
  const [templateId, setTemplateId] = useState("");
  const [task, setTask] = useState("");
  useEffect(() => {
    let active = true;
    (props.initialOptions ? Promise.resolve(props.initialOptions) : readLaunchDialogOptions())
      .then((next) => {
        if (!active) return;
        if (next.orgId !== props.orgId) {
          setLoadingError("Switch to this organization before launching.");
          return;
        }
        const initial = next.targets.find((item) =>
          host
            ? item.hostId === props.hostId
            : props.snapshotId
              ? item.snapshotId === props.snapshotId
              : item.provider === props.provider && item.golden === props.golden,
        );
        // Discovery enriches the initial source without remounting a form the person may already be editing.
        const initialId = host
          ? `host:${props.hostId}`
          : props.snapshotId
            ? `snapshot:${props.snapshotId}`
            : `${props.provider}:${props.golden}`;
        setOptions({
          ...next,
          targets: next.targets.map((item) => (item.id === initial?.id ? { ...item, id: initialId } : item)),
        });
      })
      .catch(() => {
        if (active)
          setLoadingError("Other snapshots and Docker hosts could not be loaded. Close and reopen to try again.");
      });
    return () => {
      active = false;
    };
  }, [props, host]);
  const freshSelection = options?.targets.find((item) => item.id === selected);
  const missing = {
    ...selectedTarget.current,
    reason: "This starting point is no longer available. Pick another snapshot or Docker host.",
  };
  const starts = options ? (freshSelection ? options.targets : [missing, ...options.targets]) : [fallback];
  const target = starts.find((item) => item.id === selected) ?? (options ? missing : fallback);
  const templates =
    !host && target.provider === props.provider && target.golden === props.golden ? (props.templates ?? []) : [];
  const template = templates.find((item) => item.id === templateId);
  const chooser = templates.length > 0 && (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-launch-start>
      <span>Or start from a template</span>
      {templates.map((item) => (
        <Button
          key={item.id}
          type="button"
          variant={templateId === item.id ? "secondary" : "outline"}
          size="xs"
          className="max-w-full rounded-full"
          onClick={() => setTemplateId(templateId === item.id ? "" : item.id)}
        >
          <span className="truncate">{item.name}</span>
          {templateId === item.id ? " ×" : ""}
        </Button>
      ))}
    </div>
  );
  const common = {
    starts,
    selectedStart: target.id,
    onStart: (id: string) => {
      const next = starts.find((item) => item.id === id);
      if (!next || id === selected) return;
      selectedTarget.current = next;
      focusStart.current = true;
      setSelected(id);
      setTemplateId("");
    },
    idleDelaySeconds: options?.idleDelaySeconds,
    launchBlockedReason: target.reason,
    loadingError,
    task,
    onTask: setTask,
  };
  return (
    <div ref={startRoot} className="flex min-h-0 flex-1 flex-col">
      {template ? (
        <TemplateLaunchForm
          key={template.id}
          target={template}
          task={task}
          onTask={setTask}
          loadingError={loadingError}
          idleDelaySeconds={options?.idleDelaySeconds}
          dockerLimits={props.dockerLimits}
          onRemove={() => setTemplateId("")}
        />
      ) : target.hostId ? (
        <DockerLaunchForm
          key={target.id}
          orgId={props.orgId}
          hostId={target.hostId}
          hostName={target.hostName ?? DOCKER_HOST_LABEL}
          accounts={options?.accounts ?? props.accounts}
          connections={
            options?.connections ?? (!host ? props.connections : { unavailable: "Still loading connections." })
          }
          unavailable={props.unavailable}
          dockerLimits={props.dockerLimits}
          harnesses={target.harnesses ?? ["codex"]}
          initialHarness={target.initialHarness ?? "codex"}
          {...common}
        />
      ) : (
        <LaunchForm
          key={`${target.id}:${target.harnesses?.join(",") ?? ""}`}
          golden={target.golden}
          provider={target.provider}
          hostName={target.hostName ?? DOCKER_HOST_LABEL}
          unavailable={props.unavailable}
          dockerLimits={props.dockerLimits}
          harnesses={target.harnesses}
          orgId={props.orgId}
          {...(target.snapshotId ? { snapshotId: target.snapshotId } : {})}
          repositories={target.repositories}
          {...(target.sizing ? { sizing: target.sizing } : {})}
          accounts={options?.accounts ?? props.accounts}
          catalog={options?.catalog ?? (!host ? props.catalog : MODEL_CATALOG)}
          connections={
            options?.connections ?? (!host ? props.connections : { unavailable: "Still loading connections." })
          }
          boatOpenCodeAvailable={options?.boatOpenCodeAvailable ?? (!host && props.boatOpenCodeAvailable === true)}
          templateChooser={chooser}
          {...common}
        />
      )}
    </div>
  );
}

/** Mounted with the dialog, so every opening starts from the defaults. */
function LaunchForm({
  golden,
  provider,
  snapshotId,
  hostName,
  unavailable,
  dockerLimits,
  harnesses,
  boatOpenCodeAvailable = false,
  orgId,
  catalog,
  connections,
  accounts,
  repositories,
  sizing,
  starts,
  selectedStart,
  onStart,
  idleDelaySeconds,
  templateChooser,
  task,
  onTask,
  launchBlockedReason,
  loadingError,
}: LaunchProps) {
  const id = useId();
  const [harness, setHarness] = useState<Harness>(
    harnesses?.includes("claude") ? "claude" : (harnesses?.[0] ?? "claude"),
  );
  const [credential, setCredential] = useState(() => initialLaunchSelection(accounts, catalog, harness).credentialId);
  const [accountBlocked, setAccountBlocked] = useState(false);
  const [armadaAccess, setArmadaAccess] = useState(false);
  const usableCodexAccount = (value: string) =>
    accounts.state === "ready" &&
    accountsFor(accounts.accounts, "codex").some(
      (account) => account.id === value && accountProblem(account, accounts.now) === null,
    );
  const canDelegate = provider !== "docker" && harness === "codex" && usableCodexAccount(credential);
  const access = useLaunchAccess(connections);
  const root = useRef<HTMLDivElement>(null);
  const launchKey = useRef<LaunchKey | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [localTask, setLocalTask] = useState("");
  const [skills, setSkills] = useState<string[]>([]);

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    // React resets a form after its action returns. A failed launch must keep the task and the choices that were
    // made, so the person fixes the cause and launches again; a successful one navigates away.
    const keep = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    // Every submission carries a request key, kept while the choices stay the same: a retry after an unanswered
    // launch is followed to the sandbox it started instead of launching a second one.
    const keyed = (event: Event) => {
      if (!(event instanceof FormDataEvent)) return;
      launchKey.current = launchKeyFor(launchKey.current, event.formData.entries());
      event.formData.set(LAUNCH_KEY_FIELD, launchKey.current.key);
    };
    node.addEventListener("reset", keep, true);
    node.addEventListener("formdata", keyed, true);
    return () => {
      node.removeEventListener("reset", keep, true);
      node.removeEventListener("formdata", keyed, true);
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
  const chips = composerChips(provider, repositories.length, Boolean(sizing));
  const holds = launchHoldIds(id, {
    source: Boolean(launchBlockedReason),
    account: accountBlocked || accounts.state === "unavailable",
    tools: access.held,
  });

  return (
    <div ref={root}>
      <ActionForm
        action={provider === "docker" ? launchFromDockerSnapshot : launchFromGolden}
        focusError
        renderContent={(result) => (
          <>
            <input type="hidden" name="golden" value={golden} />
            {provider === "docker" && <input type="hidden" name="snapshotId" value={snapshotId ?? ""} />}
            <input type="hidden" name="provider" value={provider} />
            <input type="hidden" name="org" value={orgId} />
            {provider !== "docker" && <input type="hidden" name="repo" value={project} />}
            <input type="hidden" name={CONNECTION_CHOICE_FIELD} value={access.explicit ? "explicit" : "defaults"} />
            {access.inputs}
            {skills.map((exact) => (
              <input key={exact} type="hidden" name="skills" value={exact} />
            ))}
            {armadaAccess && canDelegate && <input type="hidden" name="armada_access" value="on" />}
            <LaunchComposer
              id={id}
              headline={
                provider === "docker"
                  ? `What should we build on ${hostName ?? DOCKER_HOST_LABEL}?`
                  : `What should we build in ${project || golden}?`
              }
              docker={chips.docker}
              loadingError={loadingError}
              task={task ?? localTask}
              onTask={onTask ?? setLocalTask}
              chooser={templateChooser}
              holds={holds}
              tools={
                <LaunchChip
                  title="Tools"
                  label={`Tools · ${launchToolsSummary(access)}`}
                  warning={access.held || access.unavailable}
                >
                  {access.fields(id)}
                </LaunchChip>
              }
              skills={
                <LaunchChip title="Skills" label={`Skills · ${skills.length}`}>
                  <SkillPicker inline orgId={orgId} value={skills} onChange={setSkills} />
                </LaunchChip>
              }
              agent={
                <LaunchSentence
                  onBlocked={setAccountBlocked}
                  harness={harness}
                  onHarness={(next) => {
                    setHarness(next);
                    setArmadaAccess(false);
                  }}
                  account={credential}
                  onAccount={(next) => {
                    setCredential(next);
                    setArmadaAccess(false);
                  }}
                  accounts={accounts}
                  catalog={catalog}
                  allowedHarnesses={harnesses}
                  boatOpenCodeDisabled={provider === "boat" && !boatOpenCodeAvailable}
                  open={modelOpen}
                  onOpenChange={setModelOpen}
                />
              }
              alerts={
                <>
                  {launchBlockedReason && (
                    <p id={`${id}-source-blocked`} tabIndex={-1} role="alert" className="text-sm text-warning">
                      {launchBlockedReason}{" "}
                      <Link className="underline" href="/snapshots">
                        Open Snapshots
                      </Link>
                    </p>
                  )}
                  <LaunchAccountNotice
                    idPrefix={id}
                    harness={harness}
                    account={credential}
                    accounts={accounts}
                    onPick={() => setModelOpen(true)}
                  />
                  {access.alerts(() => {
                    focusLaunch.current = true;
                  }, id)}
                  {result}
                </>
              }
              location={
                <>
                  <ComposerLocation
                    name={golden}
                    starts={starts}
                    selectedStart={selectedStart}
                    onStart={onStart}
                    folder={chips.folder}
                    repositories={repositories}
                    project={project}
                    onProject={setProject}
                  />
                  {provider !== "docker" && chips.machine && sizing && (
                    <MachineSizeField provider={provider} policy={sizing.policy} repositoryDir={project} />
                  )}
                </>
              }
              options={
                <>
                  <ComposerStop provider={provider} idleDelaySeconds={idleDelaySeconds} />
                  {chips.access && (
                    <LaunchChip
                      title="Access"
                      label={`Access · ${armadaAccess && canDelegate ? "Can launch sandboxes" : "Private"}`}
                    >
                      <Label className="flex min-h-11 items-center gap-2 p-2">
                        <Checkbox
                          checked={armadaAccess && canDelegate}
                          onCheckedChange={(checked) => setArmadaAccess(checked === true)}
                          disabled={!canDelegate}
                        />
                        Let this agent launch other sandboxes
                      </Label>
                      <p className="px-2 pb-2 text-sm text-muted-foreground">
                        {canDelegate
                          ? "Manage up to 3 child sandboxes in this organization using the selected snapshot and account."
                          : "Choose Codex and an active account to enable."}
                      </p>
                    </LaunchChip>
                  )}
                  {chips.docker && <DockerLimits unavailable={unavailable} details={dockerLimits} />}
                </>
              }
            />
          </>
        )}
      />
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
export function useLaunchAccess(connections: LaunchConnections) {
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

  const alerts = (onContinue: () => void, idPrefix: string): ReactNode => (
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

  const fields = (idPrefix: string): ReactNode => {
    const personal = list.filter((item) => item.scope === "personal");
    const shared = list.filter((item) => item.scope === "org");
    return (
      <>
        {"connections" in connections && (
          <fieldset className="min-w-0 space-y-2">
            <legend className="text-sm leading-none font-medium">Tools the agent can call</legend>
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
    inputs: list
      .filter((connection) => chosen.includes(connection.id) && !launchBlocker(connection))
      .map((connection) => <input key={connection.id} type="hidden" name="connections" value={connection.id} />),
    selectedName: list.find((connection) => chosen.includes(connection.id) && launchBlocker(connection) === null)?.name,
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
          ? `${connection.toolCount} ${connection.toolCount === 1 ? "tool" : "tools"}`
          : null,
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <li className={cn("flex items-start gap-3 px-3 py-2.5", blocker && "opacity-70")}>
      <Checkbox
        id={inputId}
        checked={checked && !blocker}
        disabled={blocker !== null}
        onCheckedChange={(value) => onChange(value === true)}
        aria-describedby={hint ? `${inputId}-hint` : undefined}
        className="mt-0.5"
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
