import { accountBindingAvailability, isSandboxProvider, MODEL_CATALOG } from "@armada/core";
import { capabilities } from "@armada/core/machine-capabilities";
import { ArrowLeftIcon, ContainerIcon, LockIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
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
import { isUuid } from "@/lib/action";
import { type BillingAccount, billingAccount } from "@/lib/billing-account";
import { type AccountChoices, readAccountChoices } from "@/lib/data/account-recovery";
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
import { displayUser, listMemberships, memberDirectory, requireViewer, type Viewer } from "@/lib/data/viewer";
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
import { costOfRow } from "@/lib/sandbox-cost";
import { sandboxListName } from "@/lib/sandbox-list-name";
import { sandboxUsesRuntime } from "@/lib/sandbox-thread";
import { createClient } from "@/lib/supabase/server";
import { usageRevision } from "@/lib/usage-revision";

export const metadata: Metadata = { title: "Sandbox" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

function canShowAccountChoice(status: SandboxDetail["status"]) {
  return status === "ready" || status === "stopped";
}

export default async function SandboxPage({ params }: Props) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [viewer, supabase, selected] = await Promise.all([requireViewer(), createClient(), selectedOrganization()]);
  const pending = listMemberships(supabase, viewer.id).then((items) =>
    items.filter((item) => item.org.id === selected?.org.id),
  );
  const sandboxRead = getSandbox(supabase, id);
  // Provider reads depend on the authorized interior row, not the unrelated member directory.
  // Attach both branches to the same read so directory and provider latency overlap.
  const dockerRead = sandboxRead.then((sandbox) =>
    sandbox && capabilities(sandbox.provider).launchSource === "host"
      ? Promise.all([
          readDockerLaunchOption(),
          credentialMetadata(supabase, [sandbox.credential_id]),
          hostListForPage(),
          sandbox.owner_id === viewer.id && canShowAccountChoice(sandbox.status)
            ? readAccountChoices(viewer, sandbox.harness, sandbox.org_id)
            : undefined,
        ])
      : null,
  );
  const cloudRead = sandboxRead.then(async (sandbox) => {
    if (!sandbox || !isSandboxProvider(sandbox.provider) || sandbox.golden_id === null) return null;
    const bindingAvailability = accountBindingAvailability({
      provider: sandbox.provider,
      boatRuntime: sandbox.boat_runtime,
    });
    const recovery = sandbox.status !== "deleted" && bindingAvailability.available;
    const owner = sandbox.owner_id === viewer.id;
    const [golden, applied, accounts, choices] = await Promise.all([
      findGoldenLabel(supabase, sandbox.golden_id),
      listSandboxConnections(sandbox),
      credentialMetadata(supabase, [sandbox.credential_id]),
      recovery && owner && canShowAccountChoice(sandbox.status)
        ? readAccountChoices(viewer, sandbox.harness, sandbox.org_id)
        : undefined,
    ]);
    return { bindingAvailability, recovery, owner, golden, applied, accounts, choices };
  });
  const [sandbox, memberships, directory, docker, cloud, launchTiming] = await Promise.all([
    sandboxRead,
    pending,
    pending.then((items) =>
      memberDirectory(
        supabase,
        items.map((item) => item.org.id),
      ),
    ),
    dockerRead,
    cloudRead,
    // Same row level security as the interior: nothing is returned for a sandbox the viewer may not open.
    getLaunchTiming(supabase, id),
  ]);
  const launchFact = launchTimingFact(launchTiming);
  if (!sandbox) {
    // The interior read is refused to a member who is neither the owner nor an admin (#680). Only then is the safe
    // metadata read, so nothing of the interior is fetched and hidden; a sandbox the server does not list is not found.
    const listed = await getSandboxMetadata(supabase, id);
    // A listed sandbox the caller may open but whose interior was not returned is inconsistent: never guess at it.
    if (!listed || listed.canOpen) notFound();
    return <RestrictedSandbox sandbox={listed} owner={displayUser(directory, listed.ownerId, viewer.id)} />;
  }
  if (capabilities(sandbox.provider).launchSource === "host") {
    // A sandbox on an owned Docker host (#1165): the same page, with what the server supports on Docker. A control the
    // server marks unsupported is listed with its reason, never offered as a button it would refuse.
    if (!docker) notFound();
    const [option, accounts, hosts, choices] = docker;
    return (
      <DockerSandbox
        viewer={viewer}
        sandbox={sandbox}
        controls={dockerSandboxControls(option)}
        org={memberships.find((item) => item.org.id === sandbox.org_id)?.org.name ?? "Unknown"}
        owner={displayUser(directory, sandbox.owner_id, viewer.id)}
        cost={costOfRow(sandbox, accounts.get(sandbox.credential_id ?? "")?.kind ?? null)}
        billing={billingAccount(sandbox.credential_id, accounts)}
        ownerCanChange={sandbox.owner_id === viewer.id && sandbox.status !== "deleted"}
        {...(choices ? { choices } : {})}
        host={sandboxHostLabel(hosts, sandbox.docker_host_id)}
        launchFact={launchFact}
      />
    );
  }
  if (!isSandboxProvider(sandbox.provider) || sandbox.golden_id === null) notFound();
  const org = memberships.find((item) => item.org.id === sandbox.org_id);
  const configured = mcpUrl() !== null;
  if (!cloud) notFound();
  const { recovery, owner, golden, applied, accounts, choices } = cloud;
  const account = billingAccount(sandbox.credential_id, accounts);
  const cost = costOfRow(sandbox, accounts.get(sandbox.credential_id ?? "")?.kind ?? null);
  const repositoryDir = sandboxRepositoryDir(sandbox);
  const lifecycle = readLifecycle(sandbox);
  const life = lifecycleView(sandbox.status, lifecycle, new Date());
  const machineSize = describeEvidence(sandbox.provider, sandbox);
  // The interior row is returned only to a viewer who may open the sandbox, so the recovery command is theirs to run.

  const facts: Fact[] = [
    ["Sandbox ID", sandbox.id],
    ["Machine ID", sandbox.provider_sandbox_id ?? "Not assigned"],
    ["Snapshot", golden ? `${golden.name}${golden.removed_at ? " (removed)" : ""}` : "Unknown"],
    ["Org", org?.org.name ?? "Unknown"],
    ["Provider", sandboxProviderLabel(sandbox.provider)],
    ["Agent", HARNESS_LABELS[sandbox.harness] ?? sandbox.harness],
    ["Account", account.kindLabel ? `${account.name} (${account.kindLabel})` : account.name],
    ["Billing type", account.billing],
    ["Model", sandbox.model ?? "Provider default"],
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
  ];

  return (
    <ThreadLayout
      bar={
        <ThreadHeader sandbox={sandbox} viewer={viewer} life={life} cost={cost}>
          {configured &&
            (sandbox.status === "ready" || sandbox.status === "running") &&
            (owner || org?.role === "admin") &&
            sandbox.expires_at && <AddSandboxTime sandboxId={sandbox.id} label="Extend" compact />}
          {configured && isActiveStatus(sandbox.status) && <StopButton sandboxId={sandbox.id} size="sm" compact />}
        </ThreadHeader>
      }
      overview={
        <>
          <Facts facts={[...facts, ["Who can open it", "Owner and organization admins"]]} />
          {recovery && owner && canShowAccountChoice(sandbox.status) && (
            <SandboxAccountChoice
              sandboxId={sandbox.id}
              status={sandbox.status}
              alreadyBound={sandbox.credential_id !== null}
              owner={owner}
              {...(choices ? { choices } : {})}
              harnessLabel={HARNESS_LABELS[sandbox.harness] ?? sandbox.harness}
            />
          )}
          <LifetimeProgress sandbox={sandbox} />
          <ThreadDetails sandbox={sandbox} />
        </>
      }
      usage={
        <>
          <SandboxCostCard cost={cost} totalClassName="sm:hidden" />
          <section aria-label="Skills" className="space-y-2">
            <h2 className="text-xs font-medium text-muted-foreground">Skills</h2>
            <InstalledSkills receipts={sandbox.skills} />
          </section>
          <section aria-label="Tools" className="space-y-2">
            <h2 className="text-xs font-medium text-muted-foreground">Tools</h2>
            <AppliedConnections applied={applied} />
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

/** A Docker sandbox's page: its conversation and the controls the server supports on Docker, with reasons for the rest. */
function DockerSandbox({
  viewer,
  sandbox,
  controls,
  org,
  owner,
  cost,
  billing,
  ownerCanChange,
  choices,
  host,
  launchFact,
}: {
  sandbox: SandboxDetail;
  viewer: Viewer;
  controls: DockerSandboxControls;
  org: string;
  owner: string;
  cost: ReturnType<typeof costOfRow>;
  billing: BillingAccount;
  ownerCanChange: boolean;
  choices?: AccountChoices;
  host: string;
  launchFact: [string, string] | null;
}) {
  const configured = mcpUrl() !== null;
  const lifecycle = readLifecycle(sandbox);
  const life = lifecycleView(sandbox.status, lifecycle, new Date());
  const { reasons } = controls;
  const image = dockerImageLabel(sandbox.docker_image);
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
    ["Model", sandbox.model ?? "Provider default"],
    ["Reasoning effort", sandbox.reasoning_effort ?? "Provider default"],
    ["Owner", owner],
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
  ];
  return (
    <ThreadLayout
      docker
      bar={
        <ThreadHeader sandbox={sandbox} viewer={viewer} life={life} cost={cost}>
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
          <Facts facts={[...facts, ["Who can open it", "Owner and organization admins"]]} />
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
          <SandboxCostCard cost={cost} totalClassName="sm:hidden" />
          {configured && !reasons.exec && (sandbox.publicStatus === "ready" || sandbox.publicStatus === "running") && (
            <SandboxCommand sandboxId={sandbox.id} />
          )}
        </>
      }
    >
      <WorkspaceNotices sandbox={sandbox} viewer={viewer} life={life} />
      <p className="text-xs text-muted-foreground">Docker host sandboxes have a fixed time limit.</p>
      {ownerCanChange && canShowAccountChoice(sandbox.status) && (
        <SandboxAccountChoice
          sandboxId={sandbox.id}
          status={sandbox.status}
          alreadyBound={sandbox.credential_id !== null}
          owner
          {...(choices ? { choices } : {})}
          harnessLabel={HARNESS_LABELS[sandbox.harness] ?? sandbox.harness}
        />
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
      sandboxId={sandbox.id}
      currentConversation={sandbox.conversation_ids.at(-1)}
      initialStatus={sandbox.publicStatus}
      provider={sandbox.provider}
      preservationNote={sandbox.preservation_note}
      pinnedModel={sandboxUsesRuntime(sandbox)}
      initialIdlePaused={sandbox.status_reason === "idle_paused"}
      statusReason={sandbox.status_reason}
      expiresAt={sandbox.expires_at}
      initialUsageRevision={usageRevision(sandbox.usage_turns)}
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
  cost,
  children,
}: {
  sandbox: SandboxDetail;
  viewer: Viewer;
  life: LifecycleView;
  cost: ReturnType<typeof costOfRow>;
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
      <RowCost
        cost={cost}
        className="hidden min-w-0 max-w-20 truncate rounded-full border px-1.5 py-0.5 font-mono text-[10px] tabular-nums min-[375px]:block sm:max-w-none sm:shrink-0 sm:px-2 sm:text-xs"
      />
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
      <SandboxAttention sandbox={sandbox} viewer={viewer} />
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

/**
 * What a member who may not open a sandbox sees at its address: the metadata every member already has on the list,
 * and why the rest is closed. Its conversation, files and connections are never read for this page.
 */
function RestrictedSandbox({ sandbox, owner }: { sandbox: SandboxListMetadata; owner: string }) {
  const life = lifecycleView(sandbox.status, readLifecycle(sandbox), new Date());
  const facts: [string, string][] = [
    ["Provider", sandboxProviderLabel(sandbox.provider)],
    ["Agent", HARNESS_LABELS[sandbox.harness] ?? sandbox.harness],
    ["Model", sandbox.model ?? "Provider default"],
    ["Reasoning effort", sandbox.reasoningEffort ?? "Provider default"],
    ["Machine size", sandbox.machineSize ? machineSizeLabel(sandbox.machineSize) : "Not recorded"],
    ["Owner", owner],
    ["Created", formatDate(sandbox.createdAt)],
    // The metadata has the lifetime in force, not whether it was requested: say no more than that.
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

/** A detail row: its label, its value and, optionally, the full value for a tooltip (an image's digest). */
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

/** What the registry bound at launch. A failed read says so; it is never shown as "no connections". */
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
