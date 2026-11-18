"use client";

import type { Harness, MachineSizePolicy, SandboxPlacementProviderId } from "@armada/core";
import { MODEL_CATALOG, SANDBOX_PLACEMENT_LABELS as PROVIDER_LABELS } from "@armada/core";
import { RocketIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { launchFromDockerSnapshot } from "@/app/actions/docker-snapshots";
import { launchFromGolden, readLaunchDialogOptions } from "@/app/actions/sandboxes";
import { ActionForm } from "@/components/action-form";
import { DockerLaunchForm } from "@/components/docker-launch";
import { ComposerLocation, ComposerStop, DockerLimits, LaunchChip, LaunchComposer } from "@/components/launch-composer";
import { LaunchRepositoryContext, RepositoryPicker, WithoutRepository } from "@/components/launch-repositories";
import { LaunchAccountNotice, LaunchSentence } from "@/components/launch-sentence";
import { LaunchSnapshotBuild } from "@/components/launch-snapshot-build";
import { LaunchDialogContent } from "@/components/launch-surface";
import { LaunchTools, useLaunchAccess } from "@/components/launch-tools";
import { MachineSizeField } from "@/components/machine-size-field";
import type { ModelCatalog } from "@/components/model-fields";
import { SkillPicker } from "@/components/skill-picker";
import { TemplateLaunchForm } from "@/components/templates";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { CONNECTION_CHOICE_FIELD, type McpConnection } from "@/lib/connections";
import { DOCKER_HOST_LABEL, dockerHostGroup } from "@/lib/labels";
import { composerChips, launchHoldIds, MISSING_LAUNCH_START } from "@/lib/launch-composer";
import { LAUNCH_KEY_FIELD, type LaunchKey, launchKeyFor } from "@/lib/launch-key";
import { initialLaunchSelection, type LaunchStartTarget } from "@/lib/launch-picker";
import {
  launchRepositoryChoices,
  launchRepositoryFolder,
  launchRepositoryStarts,
  launchRepositoryTemplates,
} from "@/lib/launch-repositories";
import { accountProblem, accountsFor, type LaunchAccounts } from "@/lib/model-accounts";
import type { TemplateLaunchTarget } from "@/lib/template-launch";

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
  repositoryFolder?: string | undefined;
  repositoryFirst?: boolean;
  snapshotRepositories?: LaunchStartTarget["repositories"] | undefined;
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
  launchBlockedReason?: string | undefined;
};

/** Start with the same discovered source when entering from Sandboxes or removing a direct template. */
export function DiscoveredLaunchStart({
  target,
  options,
  dockerLimits,
  initialTask,
  initialTemplate,
}: {
  target: LaunchStartTarget;
  options: Awaited<ReturnType<typeof readLaunchDialogOptions>>;
  dockerLimits?: ReactNode;
  initialTask?: string | undefined;
  initialTemplate?: TemplateLaunchTarget | undefined;
}) {
  const common = {
    initialOptions: options,
    initialTargetId: target.id,
    orgId: options.orgId,
    accounts: options.accounts,
    dockerLimits,
    initialTask,
    initialTemplate,
    launchBlockedReason: target.reason,
  };
  return target.hostId ? (
    <LaunchStart
      {...common}
      hostId={target.hostId}
      hostName={target.hostName ?? DOCKER_HOST_LABEL}
      harnesses={target.harnesses ?? []}
      initialHarness={target.initialHarness ?? "codex"}
    />
  ) : (
    <LaunchStart
      {...common}
      golden={target.golden}
      provider={target.provider}
      harnesses={target.harnesses}
      {...(target.snapshotId ? { snapshotId: target.snapshotId } : {})}
      {...(target.hostName ? { hostName: target.hostName } : {})}
      repositories={target.repositories.map((repo) => repo.dir)}
      snapshotRepositories={target.repositories}
      {...(target.sizing ? { sizing: target.sizing } : {})}
      catalog={options.catalog}
      connections={options.connections}
      boatOpenCodeAvailable={options.boatOpenCodeAvailable}
    />
  );
}

export function LaunchStart(
  props: (LaunchProps | HostLaunchStart) & {
    initialOptions?: Awaited<ReturnType<typeof readLaunchDialogOptions>>;
    initialTargetId?: string;
    initialTask?: string | undefined;
    initialTemplate?: TemplateLaunchTarget | undefined;
  },
) {
  const [options, setOptions] = useState<Awaited<ReturnType<typeof readLaunchDialogOptions>> | null>(null);
  const [loadingError, setLoadingError] = useState("");
  const host = "hostId" in props;
  const fallback: LaunchStartTarget = host
    ? {
        id: props.initialTargetId ?? `host:${props.hostId}`,
        label: `Empty machine · ${props.hostName}`,
        group: dockerHostGroup(props.hostName),
        hostName: props.hostName,
        golden: "",
        provider: "docker",
        hostId: props.hostId,
        repositories: [],
        harnesses: props.harnesses,
        initialHarness: props.initialHarness,
        ...(props.launchBlockedReason ? { reason: props.launchBlockedReason } : {}),
      }
    : {
        id:
          props.initialTargetId ??
          (props.snapshotId ? `snapshot:${props.snapshotId}` : `${props.provider}:${props.golden}`),
        label: `${props.golden} · ${props.provider === "boat" ? "Boat cloud" : props.provider === "modal" ? "Modal cloud" : DOCKER_HOST_LABEL}`,
        group: props.provider === "docker" ? DOCKER_HOST_LABEL : `${PROVIDER_LABELS[props.provider]} cloud`,
        golden: props.golden,
        provider: props.provider,
        repositories: props.snapshotRepositories ?? [],
        ...(props.launchBlockedReason ? { reason: props.launchBlockedReason } : {}),
        ...(props.snapshotId ? { snapshotId: props.snapshotId } : {}),
        ...(props.hostName ? { hostName: props.hostName } : {}),
        ...(props.harnesses ? { harnesses: [...props.harnesses] } : {}),
        ...(props.sizing ? { sizing: props.sizing } : {}),
      };
  const fallbackId = fallback.id;
  const [selected, setSelected] = useState(fallbackId);
  const selectedTarget = useRef(fallback);
  const startRoot = useRef<HTMLDivElement>(null);
  const focusStart = useRef(false);
  useLayoutEffect(() => {
    if (!focusStart.current) return;
    focusStart.current = false;
    startRoot.current?.querySelector<HTMLButtonElement>('[data-launch-chip="From"]')?.focus();
  });
  const [templateId, setTemplateId] = useState(props.initialTemplate?.id ?? "");
  const [repository, setRepository] = useState("");
  const [fromOpen, setFromOpen] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  const [showBuild, setShowBuild] = useState(false);
  const [building, setBuilding] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const onSaved = useCallback(
    (source: LaunchStartTarget, next: Awaited<ReturnType<typeof readLaunchDialogOptions>>) => {
      setOptions(next);
      selectedTarget.current = source;
      setSelected(source.id);
      setBuilding("");
      setShowBuild(false);
      setAnnouncement(`${source.golden} is ready and selected.`);
    },
    [],
  );
  const [task, setTask] = useState(props.initialTask ?? "");
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
          props.initialTargetId
            ? item.id === props.initialTargetId
            : host
              ? item.hostId === props.hostId
              : props.snapshotId
                ? item.snapshotId === props.snapshotId
                : item.provider === props.provider && item.golden === props.golden,
        );
        // Discovery enriches the initial source without remounting a form the person may already be editing.
        const initialId = fallbackId;
        setOptions({
          ...next,
          targets: next.targets.map((item) =>
            item.id === initial?.id ? { ...item, id: initialId, sourceId: item.id } : item,
          ),
        });
      })
      .catch(() => {
        if (active)
          setLoadingError("Other snapshots and Docker hosts could not be loaded. Close and reopen to try again.");
      });
    return () => {
      active = false;
    };
  }, [props, host, fallbackId]);
  const freshSelection = options?.targets.find((item) => item.id === selected);
  const missing = {
    ...selectedTarget.current,
    reason: MISSING_LAUNCH_START,
  };
  const starts = options ? (freshSelection ? options.targets : [missing, ...options.targets]) : [fallback];
  const pinnedTarget = freshSelection ?? (options ? missing : fallback);
  const { matches, others, preferred } = launchRepositoryStarts(starts, repository);
  const target = preferred && !matches.includes(pinnedTarget) ? preferred : pinnedTarget;
  const noSnapshot = Boolean(repository && !preferred);
  function chooseRepository(value: string) {
    if (value === repository) return;
    setRepository(value);
    setTemplateId("");
    setShowBuild(false);
    setOthersOpen(false);
    const next = launchRepositoryStarts(starts, value).preferred;
    if (next) {
      selectedTarget.current = next;
      setSelected(next.id);
    }
  }
  const discoveredTemplates = options?.templates ?? (!host ? (props.templates ?? []) : []);
  const launchableTemplates = options
    ? launchRepositoryTemplates(discoveredTemplates, starts, repository, target)
    : discoveredTemplates;
  const templates =
    props.initialTemplate &&
    templateId === props.initialTemplate.id &&
    !launchableTemplates.some((item) => item.id === props.initialTemplate?.id)
      ? [...launchableTemplates, props.initialTemplate]
      : launchableTemplates;
  const template = templates.find((item) => item.id === templateId);
  const templateSource =
    template &&
    starts.find((source) =>
      template.definition.provider === "docker"
        ? template.definition.snapshotId === source.snapshotId && Boolean(source.snapshotId)
        : (source.sourceId ?? source.id) === template.definition.goldenId,
    );
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
    starts: matches,
    selectedStart: target.id,
    onStart: (id: string) => {
      const next = starts.find((item) => item.id === id);
      if (!next || building || (id === target.id && !noSnapshot)) return;
      if (repository && launchRepositoryFolder(next, repository) === undefined) setRepository("");
      setShowBuild(false);
      setOthersOpen(false);
      selectedTarget.current = next;
      focusStart.current = true;
      setSelected(id);
      setTemplateId("");
    },
    idleDelaySeconds: options?.idleDelaySeconds,
    launchBlockedReason: noSnapshot ? undefined : target.reason,
    loadingError,
    task,
    onTask: setTask,
  };
  const repositoryContext = {
    headline: (
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        What should we build in
        <RepositoryPicker
          current={repository}
          choices={launchRepositoryChoices(starts)}
          onChange={chooseRepository}
          disabled={Boolean(building)}
        />
        <span className="-ml-1">?</span>
      </span>
    ),
    withoutRepository: repository && !building ? <WithoutRepository onClick={() => chooseRepository("")} /> : null,
    repository,
    building: Boolean(building),
    fromOpen,
    setFromOpen: (open: boolean) => {
      setFromOpen(open);
      if (!open) setOthersOpen(false);
    },
    otherStarts: building ? [] : others,
    othersOpen,
    setOthersOpen,
    fromLabel: building ? `Building ${building}…` : noSnapshot ? "From · No snapshot" : undefined,
    hold: building ? (
      <p>Building {building}…</p>
    ) : noSnapshot ? (
      <div className="space-y-2 text-sm">
        <p>No snapshot has {repository} yet.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={!options} onClick={() => setShowBuild(true)}>
            Create a snapshot
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setOthersOpen(true);
              setFromOpen(true);
            }}
          >
            Use another starting point
          </Button>
        </div>
      </div>
    ) : null,
  };
  return (
    <LaunchRepositoryContext.Provider value={repositoryContext}>
      <div ref={startRoot} className="flex min-h-0 flex-1 flex-col">
        {template ? (
          <TemplateLaunchForm
            key={template.id}
            target={template}
            task={task}
            onTask={setTask}
            repositoryFolder={templateSource && launchRepositoryFolder(templateSource, repository)}
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
            templateChooser={chooser}
            {...common}
          />
        ) : (
          <LaunchForm
            key={target.id}
            golden={target.golden}
            provider={target.provider}
            hostName={target.hostName ?? DOCKER_HOST_LABEL}
            unavailable={props.unavailable}
            dockerLimits={props.dockerLimits}
            harnesses={target.harnesses}
            orgId={props.orgId}
            {...(target.snapshotId ? { snapshotId: target.snapshotId } : {})}
            repositories={
              target.repositories.length
                ? target.repositories.map((repo) => repo.dir)
                : !options && !host
                  ? props.repositories
                  : []
            }
            repositoryFolder={launchRepositoryFolder(target, repository)}
            repositoryFirst
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
        <p role="status" className="sr-only">
          {announcement}
        </p>
        {showBuild && options && (
          <LaunchSnapshotBuild repository={repository} options={options} onBuilding={setBuilding} onSaved={onSaved} />
        )}
      </div>
    </LaunchRepositoryContext.Provider>
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
  repositoryFolder,
  repositoryFirst = false,
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
  // Late discovery can rule out the initial snapshot agent. Preserve the form and its retry key.
  if (harnesses?.[0] && !harnesses.includes(harness)) {
    setHarness(harnesses[0]);
    setCredential(initialLaunchSelection(accounts, catalog, harnesses[0]).credentialId);
  }
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
  const [manualProject, setProject] = useState(
    !repositoryFirst && repositories.length === 1 ? (repositories[0] ?? "") : "",
  );
  const project = repositoryFolder ?? manualProject;
  const chips = composerChips(
    provider,
    repositoryFirst && repositories.length < 2 ? 0 : repositories.length,
    Boolean(sizing),
  );
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
              tools={<LaunchTools idPrefix={id} access={access} />}
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
