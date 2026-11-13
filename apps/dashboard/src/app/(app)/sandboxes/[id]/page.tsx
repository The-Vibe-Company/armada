import {
  isSandboxProvider,
  MODEL_CATALOG,
  SANDBOX_PLACEMENT_LABELS,
  type Sandbox,
  type SandboxListMetadata,
} from "@armada/core";
import { ArrowLeftIcon, ClockAlertIcon, ContainerIcon, LockIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConnectionStatusBadge, ScopeBadge } from "@/components/connections";
import { CopyButton } from "@/components/copy-button";
import { InstalledSkills } from "@/components/installed-skills";
import { LinkPendingIcon } from "@/components/link-pending";
import { SandboxAccountChoice } from "@/components/sandbox-account-choice";
import { SandboxActions } from "@/components/sandbox-actions";
import { SandboxAttention } from "@/components/sandbox-attention";
import { SandboxChat } from "@/components/sandbox-chat";
import { RowCost, SandboxCostCard } from "@/components/sandbox-cost";
import { SandboxDetailsPanel } from "@/components/sandbox-details-panel";
import { StatusBadge } from "@/components/status-badge";
import { OutcomeBadge, OutcomeDetail, PreservationNotice } from "@/components/task-outcome";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { bindableStatus, needsAccountChoice } from "@/lib/account-recovery";
import { isUuid } from "@/lib/action";
import { readAccountChoices } from "@/lib/data/account-recovery";
import { listSandboxConnections, type SandboxConnections } from "@/lib/data/connections";
import { hostListForPage, readDockerLaunchOption } from "@/lib/data/docker-hosts";
import { findGoldenLabel } from "@/lib/data/goldens";
import { credentialKinds, getSandbox, getSandboxMetadata } from "@/lib/data/sandboxes";
import { selectedOrganization } from "@/lib/data/selected-org";
import { displayUser, listMemberships, memberDirectory, requireViewer } from "@/lib/data/viewer";
import { sandboxHostLabel } from "@/lib/docker-hosts";
import { type DockerSandboxControls, dockerImageLabel, dockerSandboxControls } from "@/lib/docker-launch";
import { mcpUrl } from "@/lib/env";
import { isActiveStatus } from "@/lib/events";
import { PROVIDER_LABELS } from "@/lib/golden-form";
import { HARNESS_LABELS } from "@/lib/labels";
import { formatDuration, lifecycleView, readLifecycle } from "@/lib/lifecycle";
import { describeEvidence } from "@/lib/machine-size";
import { parseTaskOutcome, preservationView, settledOutcome } from "@/lib/outcome";
import { sandboxRepositoryDir } from "@/lib/repository-context";
import { machineSizeLabel, sandboxName } from "@/lib/sandbox-access";
import { costOfRow } from "@/lib/sandbox-cost";
import { createClient } from "@/lib/supabase/server";
import { usageRevision } from "@/lib/usage-revision";

export const metadata: Metadata = { title: "Sandbox" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export default async function SandboxPage({ params }: Props) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const viewer = await requireViewer();
  const supabase = await createClient();
  const selected = await selectedOrganization();
  const pending = listMemberships(supabase, viewer.id).then((items) =>
    items.filter((item) => item.org.id === selected?.org.id),
  );
  const [sandbox, memberships, directory] = await Promise.all([
    getSandbox(supabase, id),
    pending,
    pending.then((items) =>
      memberDirectory(
        supabase,
        items.map((item) => item.org.id),
      ),
    ),
  ]);
  if (!sandbox) {
    // The interior read is refused to a member who is neither the owner nor an admin (#680). Only then is the safe
    // metadata read, so nothing of the interior is fetched and hidden; a sandbox the server does not list is not found.
    const listed = await getSandboxMetadata(supabase, id);
    // A listed sandbox the caller may open but whose interior was not returned is inconsistent: never guess at it.
    if (!listed || listed.canOpen) notFound();
    return <RestrictedSandbox sandbox={listed} owner={displayUser(directory, listed.ownerId, viewer.id)} />;
  }
  if (sandbox.provider === "docker") {
    // A sandbox on an owned Docker host (#1165): the same page, with what the server supports on Docker. A control the
    // server marks unsupported is listed with its reason, never offered as a button it would refuse.
    const [option, kinds, hosts] = await Promise.all([
      readDockerLaunchOption(),
      credentialKinds(supabase, [sandbox.credential_id]),
      hostListForPage(),
    ]);
    return (
      <DockerSandbox
        sandbox={sandbox}
        controls={dockerSandboxControls(option)}
        org={memberships.find((item) => item.org.id === sandbox.org_id)?.org.name ?? "Unknown"}
        owner={displayUser(directory, sandbox.owner_id, viewer.id)}
        cost={costOfRow(sandbox, kinds.get(sandbox.credential_id ?? "") ?? null)}
        host={sandboxHostLabel(hosts, sandbox.docker_host_id)}
      />
    );
  }
  if (!isSandboxProvider(sandbox.provider) || sandbox.golden_id === null) notFound();
  const org = memberships.find((item) => item.org.id === sandbox.org_id);
  const configured = mcpUrl() !== null;
  const recovery = needsAccountChoice(sandbox);
  const owner = sandbox.owner_id === viewer.id;
  const [golden, applied, kinds, choices] = await Promise.all([
    findGoldenLabel(supabase, sandbox.golden_id),
    listSandboxConnections(sandbox),
    credentialKinds(supabase, [sandbox.credential_id]),
    recovery && owner && bindableStatus(sandbox.status) !== "failed"
      ? readAccountChoices(viewer, sandbox.harness, sandbox.org_id)
      : undefined,
  ]);
  const cost = costOfRow(sandbox, kinds.get(sandbox.credential_id ?? "") ?? null);
  const repositoryDir = sandboxRepositoryDir(sandbox);
  const lifecycle = readLifecycle(sandbox);
  const life = lifecycleView(sandbox.status, lifecycle, new Date());
  const machineSize = describeEvidence(sandbox.provider, sandbox);
  // The interior row is returned only to a viewer who may open the sandbox, so the recovery command is theirs to run.
  const outcome = settledOutcome(sandbox.status, parseTaskOutcome(sandbox.task_outcome));
  const preservation = preservationView(sandbox.preservation_note, sandbox.status, sandbox.id, true);

  const facts: [string, string][] = [
    ["Sandbox ID", sandbox.id],
    ["Machine ID", sandbox.provider_sandbox_id ?? "Not assigned"],
    ["Golden", golden ? `${golden.name}${golden.removed_at ? " (removed)" : ""}` : "Unknown"],
    ["Org", org?.org.name ?? "Unknown"],
    ["Provider", PROVIDER_LABELS[sandbox.provider] ?? sandbox.provider],
    ["Harness", HARNESS_LABELS[sandbox.harness] ?? sandbox.harness],
    ["Model", sandbox.model ?? "Provider default"],
    ["Reasoning effort", sandbox.reasoning_effort ?? "Provider default"],
    ...(repositoryDir ? [["Repository context", repositoryDir] as [string, string]] : []),
    ...(machineSize ? [["Machine size", machineSize] as [string, string]] : []),
    ["Owner", displayUser(directory, sandbox.owner_id, viewer.id)],
    ["Created", formatDate(sandbox.created_at)],
    ...(life.lifetime ? [["Lifetime", life.lifetime] as [string, string]] : []),
    ...(lifecycle.expiresAt
      ? [
          ["Deadline", `${formatDate(lifecycle.expiresAt)}${life.remaining ? `, ${life.remaining}` : ""}`] as [
            string,
            string,
          ],
        ]
      : []),
    ...(lifecycle.lastObservedAt ? [["Last checked", formatDate(lifecycle.lastObservedAt)] as [string, string]] : []),
    ["Stopped", sandbox.stopped_at ? formatDate(sandbox.stopped_at) : "Not stopped"],
    ["Conversations", String(sandbox.conversation_ids.length)],
  ];

  return (
    <div data-fit-viewport className="space-y-3 md:space-y-6">
      <div className="space-y-3">
        {/* On a phone the navigation above already leads back to the sandboxes; the conversation needs the room. */}
        <Button variant="ghost" size="sm" asChild className="-ml-3 text-muted-foreground max-md:hidden">
          <Link href="/sandboxes">
            <LinkPendingIcon>
              <ArrowLeftIcon />
            </LinkPendingIcon>
            Sandboxes
          </Link>
        </Button>
        {/* One row on every width: a long name wraps inside its heading, the machine's action stays on the right. */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 sm:gap-x-3">
            <h1 className="min-w-0 text-xl font-semibold tracking-tight break-words">
              {golden?.name ?? "Sandbox"} / {HARNESS_LABELS[sandbox.harness] ?? "Agent"}
            </h1>
            <StatusBadge
              status={sandbox.status}
              idlePaused={sandbox.status_reason === "idle_paused"}
              expiresAt={sandbox.expires_at}
            />
            {outcome && <OutcomeBadge outcome={outcome} />}
            <span className="text-xs text-muted-foreground">
              Cost: <RowCost cost={cost} />
            </span>
          </div>
          {configured && <SandboxActions sandboxId={sandbox.id} status={sandbox.status} />}
        </div>
        {outcome && <OutcomeDetail outcome={outcome} />}
        {preservation && <PreservationNotice preservation={preservation} className="max-w-2xl" />}
      </div>

      {life.notice && (
        <Alert data-lifecycle-notice={life.notice.kind} className="border-warning/40">
          <ClockAlertIcon className="text-warning" />
          <AlertTitle>{life.notice.title}</AlertTitle>
          <AlertDescription>{life.notice.text}</AlertDescription>
        </Alert>
      )}

      <div data-fit="body" className="grid items-start gap-2 md:gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div data-fit="column" className="min-w-0 space-y-2 md:space-y-6">
          {recovery && (
            <SandboxAccountChoice
              sandboxId={sandbox.id}
              status={sandbox.status}
              owner={owner}
              {...(choices ? { choices } : {})}
              harnessLabel={HARNESS_LABELS[sandbox.harness] ?? sandbox.harness}
            />
          )}
          <SandboxChat
            sandboxId={sandbox.id}
            initialStatus={sandbox.status}
            pinnedModel={sandbox.boat_runtime || sandbox.runtime_transport === "dialout"}
            initialIdlePaused={sandbox.status_reason === "idle_paused"}
            expiresAt={sandbox.expires_at}
            initialUsageRevision={usageRevision(sandbox.usage_turns)}
            live={isActiveStatus(sandbox.status)}
            harness={sandbox.harness}
            catalog={MODEL_CATALOG}
            launchedModel={sandbox.model}
            conversations={sandbox.conversation_ids}
            configured={configured}
          />
        </div>
        <SandboxDetailsPanel>
          <SandboxAttention sandbox={sandbox} viewer={viewer} />
          <Card className="gap-3 py-5">
            <CardHeader className="px-5">
              <CardTitle className="flex items-center justify-between text-sm">
                Details
                <CopyButton value={sandbox.id} label="Copy sandbox ID" />
              </CardTitle>
            </CardHeader>
            <CardContent className="px-5">
              <Facts facts={facts} />
            </CardContent>
          </Card>

          <SandboxCostCard cost={cost} />

          <InstalledSkills receipts={sandbox.skills} />

          <Card className="gap-3 py-5">
            <CardHeader className="px-5">
              <CardTitle className="text-sm">MCP connections</CardTitle>
            </CardHeader>
            <CardContent className="px-5">
              <AppliedConnections applied={applied} />
            </CardContent>
          </Card>
        </SandboxDetailsPanel>
      </div>
    </div>
  );
}

/** A Docker sandbox's page: its conversation and the controls the server supports on Docker, with reasons for the rest. */
function DockerSandbox({
  sandbox,
  controls,
  org,
  owner,
  cost,
  host,
}: {
  sandbox: Sandbox;
  controls: DockerSandboxControls;
  org: string;
  owner: string;
  cost: ReturnType<typeof costOfRow>;
  host: string;
}) {
  const configured = mcpUrl() !== null;
  const lifecycle = readLifecycle(sandbox);
  const life = lifecycleView(sandbox.status, lifecycle, new Date());
  const { reasons } = controls;
  const image = dockerImageLabel(sandbox.docker_image);
  const facts: Fact[] = [
    ["Sandbox ID", sandbox.id],
    ["Org", org],
    ["Provider", SANDBOX_PLACEMENT_LABELS.docker],
    ["Host", host],
    ["Image", image.label, image.detail ?? undefined],
    ...(sandbox.provider_sandbox_id ? [["Container", sandbox.provider_sandbox_id] as Fact] : []),
    ["Harness", HARNESS_LABELS[sandbox.harness] ?? sandbox.harness],
    ["Model", sandbox.model ?? "Provider default"],
    ["Reasoning effort", sandbox.reasoning_effort ?? "Provider default"],
    ["Owner", owner],
    ["Created", formatDate(sandbox.created_at)],
    ...(life.lifetime ? [["Lifetime", life.lifetime] as [string, string]] : []),
    ...(lifecycle.expiresAt
      ? [
          ["Deadline", `${formatDate(lifecycle.expiresAt)}${life.remaining ? `, ${life.remaining}` : ""}`] as [
            string,
            string,
          ],
        ]
      : []),
    ["Stopped", sandbox.stopped_at ? formatDate(sandbox.stopped_at) : "Not stopped"],
    ["Conversations", String(sandbox.conversation_ids.length)],
  ];
  return (
    <div data-fit-viewport data-docker-sandbox className="space-y-3 md:space-y-6">
      <div className="space-y-3">
        <Button variant="ghost" size="sm" asChild className="-ml-3 text-muted-foreground max-md:hidden">
          <Link href="/sandboxes">
            <LinkPendingIcon>
              <ArrowLeftIcon />
            </LinkPendingIcon>
            Sandboxes
          </Link>
        </Button>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 sm:gap-x-3">
            <h1 className="min-w-0 text-xl font-semibold tracking-tight break-words">
              {HARNESS_LABELS[sandbox.harness] ?? "Agent"} workspace
            </h1>
            <StatusBadge
              status={sandbox.status}
              idlePaused={sandbox.status_reason === "idle_paused"}
              expiresAt={sandbox.expires_at}
            />
          </div>
          <span className="text-xs text-muted-foreground">
            Cost: <RowCost cost={cost} />
          </span>
          {configured && (
            <SandboxActions
              sandboxId={sandbox.id}
              status={sandbox.status}
              canStop={!reasons.stop}
              canDelete={!reasons.delete}
              stopDescription={`The container stops and its workspace stays on the host.${reasons.resume ? ` It cannot be resumed from here: ${reasons.resume}` : ""}`}
            />
          )}
        </div>
      </div>

      {life.notice && (
        <Alert data-lifecycle-notice={life.notice.kind} className="border-warning/40">
          <ClockAlertIcon className="text-warning" />
          <AlertTitle>{life.notice.title}</AlertTitle>
          <AlertDescription>{life.notice.text}</AlertDescription>
        </Alert>
      )}

      <div data-fit="body" className="grid items-start gap-2 md:gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div data-fit="column" className="min-w-0 space-y-2 md:space-y-6">
          {reasons.logs ? (
            <Alert data-docker-conversation-unavailable role="status">
              <ContainerIcon />
              <AlertTitle>Conversation unavailable</AlertTitle>
              <AlertDescription>{reasons.logs}</AlertDescription>
            </Alert>
          ) : (
            <SandboxChat
              sandboxId={sandbox.id}
              initialStatus={sandbox.status}
              initialIdlePaused={sandbox.status_reason === "idle_paused"}
              expiresAt={sandbox.expires_at}
              initialUsageRevision={usageRevision(sandbox.usage_turns)}
              live={isActiveStatus(sandbox.status)}
              harness={sandbox.harness}
              catalog={MODEL_CATALOG}
              launchedModel={sandbox.model}
              conversations={sandbox.conversation_ids}
              configured={configured}
              composerUnavailable={reasons.followupPrompts}
              pinnedModel
            />
          )}
        </div>
        <SandboxDetailsPanel>
          <Card className="gap-3 py-5">
            <CardHeader className="px-5">
              <CardTitle className="flex items-center justify-between text-sm">
                Details
                <CopyButton value={sandbox.id} label="Copy sandbox ID" />
              </CardTitle>
            </CardHeader>
            <CardContent className="px-5">
              <Facts facts={facts} />
            </CardContent>
          </Card>
          <SandboxCostCard cost={cost} />
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
        </SandboxDetailsPanel>
      </div>
    </div>
  );
}

/**
 * What a member who may not open a sandbox sees at its address: the metadata every member already has on the list,
 * and why the rest is closed. Its conversation, files and connections are never read for this page.
 */
function RestrictedSandbox({ sandbox, owner }: { sandbox: SandboxListMetadata; owner: string }) {
  const life = lifecycleView(sandbox.status, readLifecycle(sandbox), new Date());
  const facts: [string, string][] = [
    ["Provider", SANDBOX_PLACEMENT_LABELS[sandbox.provider]],
    ["Harness", HARNESS_LABELS[sandbox.harness] ?? sandbox.harness],
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
    <div className="space-y-3 md:space-y-6">
      <div className="space-y-3">
        <Button variant="ghost" size="sm" asChild className="-ml-3 text-muted-foreground max-md:hidden">
          <Link href="/sandboxes">
            <LinkPendingIcon>
              <ArrowLeftIcon />
            </LinkPendingIcon>
            Sandboxes
          </Link>
        </Button>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="min-w-0 font-mono text-xl font-semibold tracking-tight break-all">{sandboxName(sandbox)}</h1>
          <StatusBadge status={sandbox.status} idlePaused={sandbox.idlePaused === true} expiresAt={sandbox.expiresAt} />
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
type Fact = [string, string] | [string, string, string | undefined];

function Facts({ facts }: { facts: Fact[] }) {
  return (
    <dl className="divide-y divide-border/70 text-[13px]">
      {facts.map(([label, value, detail]) => (
        <div key={label} className="flex min-w-0 items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0">
          <dt className="shrink-0 text-muted-foreground">{label}</dt>
          <dd className="min-w-0 text-right break-words" title={detail}>
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
    return <p className="text-sm text-muted-foreground">Launched without MCP connections you can see.</p>;
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
