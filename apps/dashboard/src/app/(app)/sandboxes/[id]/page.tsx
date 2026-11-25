import { accountBindingAvailability, isSandboxProvider, MODEL_CATALOG, type SandboxProviderId } from "@armada/core";
import { capabilities } from "@armada/core/machine-capabilities";
import { ArrowLeftIcon, ContainerIcon, LockIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { type ReactNode, Suspense } from "react";
import { ConnectionStatusBadge, ScopeBadge } from "@/components/connections";
import { CopyButton } from "@/components/copy-button";
import { InstalledSkills } from "@/components/installed-skills";
import { LinkPendingIcon } from "@/components/link-pending";
import { PullRequestSection } from "@/components/pull-requests";
import { SandboxAccountChoice } from "@/components/sandbox-account-choice";
import { SandboxActions, StopButton } from "@/components/sandbox-actions";
import { SandboxAttention } from "@/components/sandbox-attention";
import { AddSandboxTime } from "@/components/sandbox-attention-actions";
import { SandboxChat, SandboxThreadStateProvider, ThreadSandboxState } from "@/components/sandbox-chat";
import { SandboxCommand } from "@/components/sandbox-command";
import { RowCost, SandboxCostCard } from "@/components/sandbox-cost";
import { SandboxDetailsPanel } from "@/components/sandbox-details-panel";
import { SandboxState } from "@/components/sandbox-state";
import { OutcomeBadge, OutcomeDetail, PreservationNotice } from "@/components/task-outcome";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { isUuid } from "@/lib/action";
import { type BillingAccountMetadata, billingAccount } from "@/lib/billing-account";
import { readAccountChoices } from "@/lib/data/account-recovery";
import { listSandboxConnections, type SandboxConnections } from "@/lib/data/connections";
import { hostListForPage, readDockerLaunchOption } from "@/lib/data/docker-hosts";
import { findGoldenLabel } from "@/lib/data/goldens";
import {
  credentialMetadata,
  getLaunchTiming,
  getSandbox,
  getSandboxMetadata,
  type SandboxDetail,
} from "@/lib/data/sandboxes";
import { selectedOrganization } from "@/lib/data/selected-org";
import { displayUser, memberDirectory, requireViewer, type Viewer } from "@/lib/data/viewer";
import { sandboxHostLabel } from "@/lib/docker-hosts";
import { type DockerSandboxControls, dockerImageLabel, dockerSandboxControls } from "@/lib/docker-launch";
import { mcpUrl } from "@/lib/env";
import { isActiveStatus } from "@/lib/events";
import { DOCKER_HOST_LABEL, HARNESS_LABELS, sandboxProviderLabel } from "@/lib/labels";
import { launchTimingFact } from "@/lib/launch-timing";
import { formatDuration, type LifecycleView, lifecycleView, readLifecycle } from "@/lib/lifecycle";
import { describeEvidence } from "@/lib/machine-size";
import { parseTaskOutcome, preservationView, settledOutcome } from "@/lib/outcome";
import { parsePullRequests } from "@/lib/pull-requests";
import { sandboxRepositoryDir } from "@/lib/repository-context";
import { machineSizeLabel, type SandboxListMetadata } from "@/lib/sandbox-access";
import { costOfRow, usageFromRow } from "@/lib/sandbox-cost";
import { sandboxListName } from "@/lib/sandbox-list-name";
import { displayedSandboxModel } from "@/lib/sandbox-model";
import { sandboxUsesRuntime } from "@/lib/sandbox-thread";
import { createClient, type Supabase } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Sandbox" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };
type AccountsPromise = Promise<Map<string, BillingAccountMetadata>>;

function canShowAccountChoice(status: SandboxDetail["status"]) {
  return status === "ready" || status === "stopped";
}

export default async function SandboxPage({ params }: Props) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [viewer, supabase, selected] = await Promise.all([requireViewer(), createClient(), selectedOrganization()]);
  const sandbox = await getSandbox(supabase, id);
  if (!sandbox) {
    const [listed, directory] = await Promise.all([
      getSandboxMetadata(supabase, id),
      memberDirectory(supabase, selected ? [selected.org.id] : []),
    ]);
    if (!listed || listed.canOpen) notFound();
    return <RestrictedSandbox sandbox={listed} owner={displayUser(directory, listed.ownerId, viewer.id)} />;
  }
  const org = selected?.org.id === sandbox.org_id ? selected : undefined;
  const accounts = credentialMetadata(supabase, [sandbox.credential_id]);
  if (capabilities(sandbox.provider).launchSource === "host") {
    const option = await readDockerLaunchOption();
    return (
      <DockerSandbox
        viewer={viewer}
        supabase={supabase}
        sandbox={sandbox}
        controls={dockerSandboxControls(option)}
        org={org?.org.name ?? "Unknown"}
        accounts={accounts}
        ownerCanChange={sandbox.owner_id === viewer.id && sandbox.status !== "deleted"}
      />
    );
  }
  if (!isSandboxProvider(sandbox.provider) || sandbox.golden_id === null) notFound();
  const configured = mcpUrl() !== null;
  const bindingAvailability = accountBindingAvailability({
    provider: sandbox.provider,
    boatRuntime: sandbox.boat_runtime,
  });
  const recovery = sandbox.status !== "deleted" && bindingAvailability.available;
  const owner = sandbox.owner_id === viewer.id;
  const lifecycle = readLifecycle(sandbox);
  const life = lifecycleView(sandbox.status, lifecycle, new Date());

  return (
    <ThreadLayout
      bar={
        <ThreadHeader sandbox={sandbox} viewer={viewer} life={life} accounts={accounts}>
          {configured &&
            (sandbox.status === "ready" || sandbox.status === "running") &&
            (owner || org?.role === "admin") &&
            sandbox.expires_at && <AddSandboxTime sandboxId={sandbox.id} label="Extend" compact />}
          {configured && isActiveStatus(sandbox.status) && <StopButton sandboxId={sandbox.id} size="sm" compact />}
        </ThreadHeader>
      }
      overview={
        <>
          <Suspense fallback={<FactsSkeleton />}>
            <CloudOverviewFacts
              sandbox={sandbox}
              provider={sandbox.provider}
              goldenId={sandbox.golden_id}
              viewer={viewer}
              supabase={supabase}
              orgName={org?.org.name ?? "Unknown"}
              life={life}
              accounts={accounts}
            />
          </Suspense>
          {recovery && owner && canShowAccountChoice(sandbox.status) && (
            <Suspense fallback={null}>
              <SandboxAccountChoiceSection sandbox={sandbox} viewer={viewer} owner={owner} />
            </Suspense>
          )}
          <LifetimeProgress sandbox={sandbox} />
          <ThreadDetails sandbox={sandbox} />
        </>
      }
      usage={
        <>
          <Suspense fallback={<CostSkeleton />}>
            <SandboxCostSection sandbox={sandbox} accounts={accounts} />
          </Suspense>
          <section aria-label="Skills" className="space-y-2">
            <h2 className="text-xs font-medium text-muted-foreground">Skills</h2>
            <InstalledSkills receipts={sandbox.skills} />
          </section>
          <section aria-label="Tools" className="space-y-2">
            <h2 className="text-xs font-medium text-muted-foreground">Tools</h2>
            <Suspense fallback={<ConnectionsSkeleton />}>
              <CloudAppliedConnections sandbox={sandbox} />
            </Suspense>
          </section>
          {configured && (sandbox.status === "ready" || sandbox.status === "running") && (
            <SandboxCommand sandboxId={sandbox.id} />
          )}
        </>
      }
    >
      <WorkspaceNotices sandbox={sandbox} viewer={viewer} life={life} />
      <ThreadConversation sandbox={sandbox} configured={configured} />
    </ThreadLayout>
  );
}

async function CloudOverviewFacts({
  sandbox,
  provider,
  goldenId,
  viewer,
  supabase,
  orgName,
  life,
  accounts,
}: {
  sandbox: SandboxDetail;
  provider: SandboxProviderId;
  goldenId: string;
  viewer: Viewer;
  supabase: Supabase;
  orgName: string;
  life: LifecycleView;
  accounts: AccountsPromise;
}) {
  const [golden, directory, launchTiming, accountMap] = await Promise.all([
    findGoldenLabel(supabase, goldenId),
    memberDirectory(supabase, [sandbox.org_id]),
    getLaunchTiming(supabase, sandbox.id),
    accounts,
  ]);
  const account = billingAccount(sandbox.credential_id, accountMap);
  const repositoryDir = sandboxRepositoryDir(sandbox);
  const lifecycle = readLifecycle(sandbox);
  const machineSize = describeEvidence(provider, sandbox);
  const launchFact = launchTimingFact(launchTiming);
  const executedModels = usageFromRow(sandbox).turns.map((turn) => turn.model);
  const facts: Fact[] = [
    ["Sandbox ID", sandbox.id],
    ["Machine ID", sandbox.provider_sandbox_id ?? "Not assigned"],
    ["Snapshot", golden ? `${golden.name}${golden.removed_at ? " (removed)" : ""}` : "Unknown"],
    ["Org", orgName],
    ["Provider", sandboxProviderLabel(sandbox.provider)],
    ["Agent", HARNESS_LABELS[sandbox.harness] ?? sandbox.harness],
    ["Account", account.kindLabel ? `${account.name} (${account.kindLabel})` : account.name],
    ["Billing type", account.billing],
    ["Model", displayedSandboxModel(sandbox.harness, sandbox.model, executedModels) ?? "Provider default"],
    ["Reasoning effort", sandbox.reasoning_effort ?? "Provider default"],
    ...(repositoryDir ? [["Repository context", repositoryDir] as [string, string]] : []),
    ...(machineSize ? [["Machine size", machineSize] as [string, string]] : []),
    ["Owner", displayUser(directory, sandbox.owner_id, viewer.id)],
    ["Created", formatDate(sandbox.created_at)],
    ...(launchFact ? [launchFact] : []),
    ...(life.lifetime ? [["Lifetime", life.lifetime] as [string, string]] : []),
    ...(lifecycle.expiresAt
      ? [
          [
            "Deadline",
            <>
              <span>{formatDate(lifecycle.expiresAt)}</span>
              {life.remaining && <span className="block xl:hidden">{life.remaining}</span>}
            </>,
          ] as Fact,
        ]
      : []),
    ...(lifecycle.lastObservedAt ? [["Last checked", formatDate(lifecycle.lastObservedAt)] as [string, string]] : []),
    ["Stopped", sandbox.stopped_at ? formatDate(sandbox.stopped_at) : "Not stopped"],
    ["Conversations", String(sandbox.conversation_ids.length)],
    ["Who can open it", "Owner and organization admins"],
  ];
  return <Facts facts={facts} />;
}

async function DockerOverviewFacts({
  sandbox,
  viewer,
  supabase,
  org,
  life,
  accounts,
}: {
  sandbox: SandboxDetail;
  viewer: Viewer;
  supabase: Supabase;
  org: string;
  life: LifecycleView;
  accounts: AccountsPromise;
}) {
  const [hosts, directory, launchTiming, accountMap] = await Promise.all([
    hostListForPage(),
    memberDirectory(supabase, [sandbox.org_id]),
    getLaunchTiming(supabase, sandbox.id),
    accounts,
  ]);
  const billing = billingAccount(sandbox.credential_id, accountMap);
  const host = sandboxHostLabel(hosts, sandbox.docker_host_id);
  const launchFact = launchTimingFact(launchTiming);
  const lifecycle = readLifecycle(sandbox);
  const image = dockerImageLabel(sandbox.docker_image);
  const executedModels = usageFromRow(sandbox).turns.map((turn) => turn.model);
  const facts: Fact[] = [
    ["Sandbox ID", sandbox.id],
    ["Org", org],
    ["Provider", `${DOCKER_HOST_LABEL} ${host}`],
    [DOCKER_HOST_LABEL, host],
    ["Image", image.label, image.detail ?? undefined],
    ...(sandbox.provider_sandbox_id ? [["Container", sandbox.provider_sandbox_id] as Fact] : []),
    ["Agent", HARNESS_LABELS[sandbox.harness] ?? sandbox.harness],
    ["Account", billing.kindLabel ? `${billing.name} (${billing.kindLabel})` : billing.name],
    ["Billing type", billing.billing],
    ["Model", displayedSandboxModel(sandbox.harness, sandbox.model, executedModels) ?? "Provider default"],
    ["Reasoning effort", sandbox.reasoning_effort ?? "Provider default"],
    ["Owner", displayUser(directory, sandbox.owner_id, viewer.id)],
    ["Created", formatDate(sandbox.created_at)],
    ...(launchFact ? [launchFact as Fact] : []),
    ...(life.lifetime ? [["Lifetime", life.lifetime] as [string, string]] : []),
    ...(lifecycle.expiresAt
      ? [
          [
            "Deadline",
            <>
              <span>{formatDate(lifecycle.expiresAt)}</span>
              {life.remaining && <span className="block xl:hidden">{life.remaining}</span>}
            </>,
          ] as Fact,
        ]
      : []),
    ["Stopped", sandbox.stopped_at ? formatDate(sandbox.stopped_at) : "Not stopped"],
    ["Conversations", String(sandbox.conversation_ids.length)],
    ["Who can open it", "Owner and organization admins"],
  ];
  return <Facts facts={facts} />;
}

async function SandboxAccountChoiceSection({
  sandbox,
  viewer,
  owner,
}: {
  sandbox: SandboxDetail;
  viewer: Viewer;
  owner: boolean;
}) {
  const choices = await readAccountChoices(viewer, sandbox.harness, sandbox.org_id);
  return (
    <SandboxAccountChoice
      sandboxId={sandbox.id}
      status={sandbox.status}
      alreadyBound={sandbox.credential_id !== null}
      owner={owner}
      choices={choices}
      harnessLabel={HARNESS_LABELS[sandbox.harness] ?? sandbox.harness}
    />
  );
}

async function CloudAppliedConnections({ sandbox }: { sandbox: SandboxDetail }) {
  const applied = await listSandboxConnections(sandbox);
  return <AppliedConnections applied={applied} />;
}

async function HeaderCost({ sandbox, accounts }: { sandbox: SandboxDetail; accounts: AccountsPromise }) {
  const accountMap = await accounts;
  const cost = costOfRow(sandbox, accountMap.get(sandbox.credential_id ?? "")?.kind ?? null);
  return (
    <RowCost
      cost={cost}
      className="hidden min-w-0 max-w-20 truncate rounded-full border px-1.5 py-0.5 font-mono text-[10px] tabular-nums min-[375px]:block sm:max-w-none sm:shrink-0 sm:px-2 sm:text-xs"
    />
  );
}

async function SandboxCostSection({ sandbox, accounts }: { sandbox: SandboxDetail; accounts: AccountsPromise }) {
  const accountMap = await accounts;
  const cost = costOfRow(sandbox, accountMap.get(sandbox.credential_id ?? "")?.kind ?? null);
  return <SandboxCostCard cost={cost} totalClassName="sm:hidden" />;
}

function FactsSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-2.5">
      {[0, 1, 2, 3, 4, 5].map((key) => (
        <div key={key} className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3">
          <Skeleton className="h-3.5 w-16" />
          <Skeleton className="h-3.5 w-full" />
        </div>
      ))}
    </div>
  );
}

function CostSkeleton() {
  return <Skeleton aria-hidden="true" className="h-16 w-full rounded-lg" />;
}

function ConnectionsSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-2">
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-3/4 rounded-md" />
    </div>
  );
}

function DockerSandbox({
  viewer,
  supabase,
  sandbox,
  controls,
  org,
  accounts,
  ownerCanChange,
}: {
  sandbox: SandboxDetail;
  viewer: Viewer;
  supabase: Supabase;
  controls: DockerSandboxControls;
  org: string;
  accounts: AccountsPromise;
  ownerCanChange: boolean;
}) {
  const configured = mcpUrl() !== null;
  const lifecycle = readLifecycle(sandbox);
  const life = lifecycleView(sandbox.status, lifecycle, new Date());
  const { reasons } = controls;
  return (
    <ThreadLayout
      docker
      bar={
        <ThreadHeader sandbox={sandbox} viewer={viewer} life={life} accounts={accounts}>
          {configured && (
            <SandboxActions
              sandboxId={sandbox.id}
              status={sandbox.status}
              canStop={!reasons.stop}
              canDelete={!reasons.delete}
              stopDescription={`The container stops and its workspace stays on the host.${reasons.resume ? ` It cannot be resumed from here: ${reasons.resume}` : ""}`}
            />
          )}
        </ThreadHeader>
      }
      overview={
        <>
          <Suspense fallback={<FactsSkeleton />}>
            <DockerOverviewFacts
              sandbox={sandbox}
              viewer={viewer}
              supabase={supabase}
              org={org}
              life={life}
              accounts={accounts}
            />
          </Suspense>
          <ThreadDetails sandbox={sandbox} />
          {controls.unavailable.length > 0 && (
            <Card className="gap-3 py-5" data-docker-unavailable>
              <CardHeader className="px-5">
                <CardTitle className="text-sm">Not available on Docker yet</CardTitle>
              </CardHeader>
              <CardContent className="px-5">
                <ul className="space-y-1.5 text-[13px]">
                  {controls.unavailable.map((item) => (
                    <li key={item.name}>
                      <span className="font-medium">{item.name}</span>
                      <span className="text-muted-foreground">: {item.reason}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      }
      usage={
        <>
          <Suspense fallback={<CostSkeleton />}>
            <SandboxCostSection sandbox={sandbox} accounts={accounts} />
          </Suspense>
          {configured && !reasons.exec && (sandbox.publicStatus === "ready" || sandbox.publicStatus === "running") && (
            <SandboxCommand sandboxId={sandbox.id} />
          )}
        </>
      }
    >
      <WorkspaceNotices sandbox={sandbox} viewer={viewer} life={life} />
      <p className="text-xs text-muted-foreground">Docker host sandboxes have a fixed time limit.</p>
      {ownerCanChange && canShowAccountChoice(sandbox.status) && (
        <Suspense fallback={null}>
          <SandboxAccountChoiceSection sandbox={sandbox} viewer={viewer} owner />
        </Suspense>
      )}
      {reasons.logs ? (
        <Alert data-docker-conversation-unavailable role="status">
          <ContainerIcon />
          <AlertTitle>Conversation unavailable</AlertTitle>
          <AlertDescription>{reasons.logs}</AlertDescription>
        </Alert>
      ) : (
        <ThreadConversation sandbox={sandbox} configured={configured} composerUnavailable={reasons.followupPrompts} />
      )}
    </ThreadLayout>
  );
}

function LifetimeProgress({ sandbox }: { sandbox: SandboxDetail }) {
  const { expiresAt, effectiveTtlSeconds } = readLifecycle(sandbox);
  const remaining =
    expiresAt && effectiveTtlSeconds
      ? Math.round(Math.max(0, Math.min(100, (Date.parse(expiresAt) - Date.now()) / (effectiveTtlSeconds * 10))))
      : null;
  return (
    <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
      {remaining !== null && isActiveStatus(sandbox.status) && (
        <div
          role="progressbar"
          aria-label="Lifetime remaining"
          aria-valuenow={remaining}
          className="h-1 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-foreground/55" style={{ width: `${remaining}%` }} />
        </div>
      )}
      <p>Stopping keeps the disk and the conversation. Send a prompt to resume.</p>
    </div>
  );
}

function ThreadConversation({
  sandbox,
  configured,
  composerUnavailable,
}: {
  sandbox: SandboxDetail;
  configured: boolean;
  composerUnavailable?: string | undefined;
}) {
  return (
    <SandboxChat
      key={sandbox.id}
      orgId={sandbox.org_id}
      sandboxId={sandbox.id}
      currentConversation={sandbox.conversation_ids.at(-1)}
      initialStatus={sandbox.publicStatus}
      provider={sandbox.provider}
      preservationNote={sandbox.preservation_note}
      pinnedModel={sandboxUsesRuntime(sandbox)}
      initialIdlePaused={sandbox.status_reason === "idle_paused"}
      statusReason={sandbox.status_reason}
      expiresAt={sandbox.expires_at}
      live={isActiveStatus(sandbox.status)}
      harness={sandbox.harness}
      catalog={MODEL_CATALOG}
      launchedModel={sandbox.model}
      configured={configured}
      composerUnavailable={composerUnavailable}
    />
  );
}

function ThreadDetails({ sandbox }: { sandbox: SandboxDetail }) {
  const outcome = settledOutcome(
    sandbox.status,
    parseTaskOutcome(sandbox.task_outcome),
    parsePullRequests(sandbox.pull_requests),
  );
  const preservation = preservationView(sandbox.preservation_note, sandbox.status, sandbox.id, true);
  return (
    <>
      <PullRequestSection value={sandbox.pull_requests} />
      {outcome && (
        <div className="space-y-1">
          <OutcomeBadge outcome={outcome} />
          <OutcomeDetail outcome={outcome} />
        </div>
      )}
      {preservation && <PreservationNotice preservation={preservation} />}
    </>
  );
}

function ThreadHeader({
  sandbox,
  viewer,
  life,
  accounts,
  children,
}: {
  sandbox: SandboxDetail;
  viewer: Viewer;
  life: LifecycleView;
  accounts: AccountsPromise;
  children: ReactNode;
}) {
  const name = sandboxListName({
    providerSandboxId: sandbox.provider_sandbox_id,
    displayLabel: `${HARNESS_LABELS[sandbox.harness]} sandbox`,
    harness: sandbox.harness,
    createdAt: sandbox.created_at,
  });
  return (
    <>
      <Button variant="ghost" size="icon-sm" asChild>
        <Link href="/sandboxes" aria-label="Back to sandboxes" title="Back to sandboxes">
          <LinkPendingIcon>
            <ArrowLeftIcon />
          </LinkPendingIcon>
        </Link>
      </Button>
      <div className="min-w-10 flex-1">
        <h1 className="truncate text-sm font-semibold leading-tight" title={name}>
          {name}
        </h1>
        <div className="flex items-center gap-0.5">
          <span className="truncate font-mono text-[10px] leading-tight text-muted-foreground">
            {sandbox.id.slice(0, 8)}
          </span>
          <CopyButton value={sandbox.id} label="Copy sandbox ID" className="size-6" />
        </div>
      </div>
      <ThreadSandboxState
        viewerOwns={sandbox.owner_id === viewer.id}
        status={sandbox.publicStatus}
        statusMessage={sandbox.status_reason}
        readyLabel={parseTaskOutcome(sandbox.task_outcome)?.state === "ready" ? "Finished" : "Ready"}
        idlePaused={sandbox.status_reason === "idle_paused"}
        expiresAt={sandbox.expires_at}
      />
      {life.remaining && (
        <span className="hidden whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground xl:inline">
          {life.remaining}
        </span>
      )}
      <Suspense fallback={null}>
        <HeaderCost sandbox={sandbox} accounts={accounts} />
      </Suspense>
      {children}
    </>
  );
}

function WorkspaceNotices({ sandbox, viewer, life }: { sandbox: SandboxDetail; viewer: Viewer; life: LifecycleView }) {
  return (
    <>
      {life.notice && (
        <p className="text-sm text-muted-foreground">
          {life.notice.title} · {life.notice.text}
        </p>
      )}
      <Suspense fallback={null}>
        <SandboxAttention sandbox={sandbox} viewer={viewer} />
      </Suspense>
    </>
  );
}

function ThreadLayout({
  docker,
  bar,
  overview,
  usage,
  children,
}: {
  docker?: boolean;
  bar: ReactNode;
  overview: ReactNode;
  usage: ReactNode;
  children: ReactNode;
}) {
  return (
    <SandboxThreadStateProvider>
      <div data-fit-viewport data-docker-sandbox={docker || undefined} className="min-w-0 space-y-3">
        <SandboxDetailsPanel bar={bar} overview={overview} usage={usage}>
          {children}
        </SandboxDetailsPanel>
      </div>
    </SandboxThreadStateProvider>
  );
}

function RestrictedSandbox({ sandbox, owner }: { sandbox: SandboxListMetadata; owner: string }) {
  const life = lifecycleView(sandbox.status, readLifecycle(sandbox), new Date());
  const facts: [string, string][] = [
    ["Provider", sandboxProviderLabel(sandbox.provider)],
    ["Agent", HARNESS_LABELS[sandbox.harness] ?? sandbox.harness],
    ["Model", displayedSandboxModel(sandbox.harness, sandbox.model) ?? "Provider default"],
    ["Reasoning effort", sandbox.reasoningEffort ?? "Provider default"],
    ["Machine size", sandbox.machineSize ? machineSizeLabel(sandbox.machineSize) : "Not recorded"],
    ["Owner", owner],
    ["Created", formatDate(sandbox.createdAt)],
    ...(sandbox.effectiveTtlSeconds === null
      ? []
      : [["Lifetime", formatDuration(sandbox.effectiveTtlSeconds)] as [string, string]]),
    ...(sandbox.expiresAt
      ? [
          ["Deadline", `${formatDate(sandbox.expiresAt)}${life.remaining ? `, ${life.remaining}` : ""}`] as [
            string,
            string,
          ],
        ]
      : []),
    ["Stopped", sandbox.stoppedAt ? formatDate(sandbox.stoppedAt) : "Not stopped"],
  ];
  return (
    <div className="space-y-3 md:space-y-4">
      <div className="space-y-3">
        <Button variant="ghost" size="sm" asChild className="-ml-3 text-muted-foreground">
          <Link href="/sandboxes">
            <LinkPendingIcon>
              <ArrowLeftIcon />
            </LinkPendingIcon>
            Sandboxes <span aria-hidden>/</span>
            <span className="font-mono text-xs">{sandbox.id.slice(0, 8)}</span>
          </Link>
        </Button>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="min-w-0 font-mono text-xl font-semibold tracking-tight break-all">
            {HARNESS_LABELS[sandbox.harness] ?? "Agent"} sandbox
          </h1>
          <SandboxState
            viewerOwns={false}
            status={sandbox.status}
            activityLabel={sandbox.status === "running" ? "Running" : undefined}
            idlePaused={sandbox.idlePaused === true}
            readyLabel="Waiting for you"
            expiresAt={sandbox.expiresAt}
          />
        </div>
      </div>
      <Alert data-restricted role="status">
        <LockIcon />
        <AlertTitle>Owner and admins only</AlertTitle>
        <AlertDescription>
          Only its owner and organization admins can open this sandbox. Every member sees that it exists; its
          conversation, files and connections stay closed to them.
        </AlertDescription>
      </Alert>
      <Card className="max-w-xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <Facts facts={facts} />
        </CardContent>
      </Card>
    </div>
  );
}

type Fact = [string, ReactNode] | [string, ReactNode, string | undefined];

function Facts({ facts }: { facts: Fact[] }) {
  return (
    <dl className="divide-y divide-border/70 text-[13px]">
      {facts.map(([label, value, detail]) => (
        <div
          key={label}
          className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-3 py-2 first:pt-0 last:pb-0"
        >
          <dt className="shrink-0 text-muted-foreground">{label}</dt>
          <dd className="min-w-0 font-mono text-xs break-words tabular-nums" title={detail}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function AppliedConnections({ applied }: { applied: SandboxConnections }) {
  if (applied.state === "not-configured") {
    return <p className="text-sm text-muted-foreground">The Armada server is not configured for this dashboard.</p>;
  }
  if (applied.state === "error") {
    return (
      <p role="alert" className="text-sm text-destructive">
        The connections of this sandbox could not be loaded: {applied.message}
      </p>
    );
  }
  if (applied.connections.length === 0) {
    return <p className="text-sm text-muted-foreground">Launched without Tools you can see.</p>;
  }
  return (
    <ul className="divide-y rounded-md border" aria-label="Applied connections">
      {applied.connections.map((connection) => (
        <li key={connection.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
          <span className="font-medium">{connection.name}</span>
          <ScopeBadge scope={connection.scope} />
          <ConnectionStatusBadge connection={connection} />
          {connection.status !== "connected" && (
            <span className="text-xs text-muted-foreground">
              New sessions cannot reach it until it is connected again.
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function formatDate(iso: string): string {
  return `${new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" })} UTC`;
}
