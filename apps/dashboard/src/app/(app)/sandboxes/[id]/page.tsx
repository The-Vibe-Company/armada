import { accountBindingAvailability, isSandboxProvider, MODEL_CATALOG, type SandboxListMetadata } from "@armada/core";
import { ArrowLeftIcon, ContainerIcon, LockIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ConnectionStatusBadge, ScopeBadge } from "@/components/connections";
import { CreatedAt } from "@/components/created-at";
import { InstalledSkills } from "@/components/installed-skills";
import { LinkPendingIcon } from "@/components/link-pending";
import { SandboxAccountChoice } from "@/components/sandbox-account-choice";
import { SandboxActions, StopButton } from "@/components/sandbox-actions";
import { SandboxAttention } from "@/components/sandbox-attention";
import { AddSandboxTime } from "@/components/sandbox-attention-actions";
import { SandboxChat } from "@/components/sandbox-chat";
import { SandboxCommand } from "@/components/sandbox-command";
import { RowCost, SandboxCostCard } from "@/components/sandbox-cost";
import { SandboxDetailsPanel } from "@/components/sandbox-details-panel";
import { SandboxState } from "@/components/sandbox-state";
import { ShellPageActions } from "@/components/shell-page-actions";
import { OutcomeBadge, OutcomeDetail, PreservationNotice } from "@/components/task-outcome";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { bindableStatus } from "@/lib/account-recovery";
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
import { HARNESS_LABELS } from "@/lib/labels";
import { launchTimingFact } from "@/lib/launch-timing";
import { formatDuration, lifecycleView, readLifecycle } from "@/lib/lifecycle";
import { describeEvidence } from "@/lib/machine-size";
import { parseTaskOutcome, preservationView, settledOutcome } from "@/lib/outcome";
import { sandboxRepositoryDir } from "@/lib/repository-context";
import { machineSizeLabel } from "@/lib/sandbox-access";
import { costOfRow } from "@/lib/sandbox-cost";
import { createClient } from "@/lib/supabase/server";
import { usageRevision } from "@/lib/usage-revision";

export const metadata: Metadata = { title: "Sandbox" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

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
    sandbox?.provider === "docker"
      ? Promise.all([
          readDockerLaunchOption(),
          credentialMetadata(supabase, [sandbox.credential_id]),
          hostListForPage(),
          sandbox.owner_id === viewer.id && sandbox.status !== "deleted"
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
      recovery && owner && bindableStatus(sandbox.status) !== "failed"
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
  if (sandbox.provider === "docker") {
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

  const facts: [string, string][] = [
    ["Sandbox ID", sandbox.id],
    ["Machine ID", sandbox.provider_sandbox_id ?? "Not assigned"],
    ["Snapshot", golden ? `${golden.name}${golden.removed_at ? " (removed)" : ""}` : "Unknown"],
    ["Org", org?.org.name ?? "Unknown"],
    ["Provider", sandbox.provider === "boat" ? "Boat cloud" : "Modal cloud"],
    ["Harness", HARNESS_LABELS[sandbox.harness] ?? sandbox.harness],
    ["Account", account.name],
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
    <div data-fit-viewport className="space-y-3 md:space-y-4">
      <ShellPageActions>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 sm:gap-x-3">
            <ShellPageActions slot="status">
              <SandboxState
                viewerOwns={owner}
                status={sandbox.status}
                statusMessage={sandbox.status_reason}
                readyLabel={parseTaskOutcome(sandbox.task_outcome)?.state === "ready" ? "Finished" : "Waiting for you"}
                idlePaused={sandbox.status_reason === "idle_paused"}
                expiresAt={sandbox.expires_at}
              />
            </ShellPageActions>
            {sandbox.status === "running" && sandbox.status_reason && sandbox.status_reason !== "idle_paused" && (
              <span className="text-sm text-muted-foreground">{sandbox.status_reason}</span>
            )}
            {life.remaining && <span className="text-sm text-muted-foreground">{life.remaining}</span>}
            <span className="text-xs text-muted-foreground">
              <RowCost cost={cost} />
            </span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {configured &&
              (sandbox.status === "ready" || sandbox.status === "running") &&
              (owner || org?.role === "admin") &&
              sandbox.expires_at && <AddSandboxTime sandboxId={sandbox.id} label="Extend" />}
            {configured && isActiveStatus(sandbox.status) && <StopButton sandboxId={sandbox.id} size="sm" />}
          </div>
        </div>
      </ShellPageActions>

      {life.notice && (
        <p className="text-sm text-muted-foreground">
          {life.notice.title} · {life.notice.text}
        </p>
      )}
      <SandboxAttention sandbox={sandbox} viewer={viewer} />

      <div
        data-fit="body"
        className="grid items-start gap-2 md:gap-6 lg:grid-cols-[minmax(0,1fr)_19.5rem] lg:has-[[data-details-open=false]]:grid-cols-1"
      >
        <div data-fit="column" className="min-w-0 space-y-2 md:space-y-6">
          <SandboxChat
            sandboxId={sandbox.id}
            initialStatus={sandbox.status}
            provider={sandbox.provider}
            preservationNote={sandbox.preservation_note}
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
          <footer className="flex flex-wrap gap-x-4 gap-y-1 px-4 font-mono text-[11px] text-muted-foreground">
            <span>{sandbox.model ?? "Provider default"}</span>
            <span>
              {sandbox.provider} · {HARNESS_LABELS[sandbox.harness]}
            </span>
            <span>{life.remaining ?? life.lifetime}</span>
            <span>⌘ / Ctrl + Enter to send</span>
          </footer>
        </div>
        <SandboxDetailsPanel>
          <section className="space-y-4 text-sm" aria-label="About">
            <h2 className="text-xs font-medium text-muted-foreground">Agent</h2>
            <Facts
              facts={[
                ["Harness", HARNESS_LABELS[sandbox.harness] ?? sandbox.harness],
                ["Model", sandbox.model ?? "Provider default"],
                ["Effort", sandbox.reasoning_effort ?? "Provider default"],
              ]}
            />
            <BillingAccountSummary account={account} />
            <h2 className="text-xs font-medium text-muted-foreground">Workspace</h2>
            <Facts
              facts={[
                ["Snapshot", golden?.name ?? "Unknown"],
                ...(repositoryDir ? [["Repository context", repositoryDir] as [string, string]] : []),
                ["Provider", sandbox.provider === "boat" ? "Boat cloud" : "Modal cloud"],
                ...(machineSize ? [["Machine size", machineSize] as [string, string]] : []),
              ]}
            />
            <h2 className="text-xs font-medium text-muted-foreground">Access</h2>
            <Facts
              facts={[
                ["Owner", displayUser(directory, sandbox.owner_id, viewer.id)],
                ["Who can open it", "Owner and organization admins"],
                ["ID", sandbox.id],
              ]}
            />
            {recovery && owner && (sandbox.status === "ready" || sandbox.status === "stopped") && (
              <details>
                <summary className="cursor-pointer text-muted-foreground">Change account</summary>
                {
                  <SandboxAccountChoice
                    sandboxId={sandbox.id}
                    status={sandbox.status}
                    alreadyBound={sandbox.credential_id !== null}
                    owner={owner}
                    {...(choices ? { choices } : {})}
                    harnessLabel={HARNESS_LABELS[sandbox.harness] ?? sandbox.harness}
                  />
                }
              </details>
            )}
          </section>
          <section className="space-y-3 text-xs">
            <h2 className="font-medium text-muted-foreground">Lifetime</h2>
            <p className="font-mono">{life.remaining ?? life.lifetime ?? "No time limit recorded"}</p>
            {lifecycle.expiresAt && lifecycle.effectiveTtlSeconds && isActiveStatus(sandbox.status) ? (
              <div
                role="progressbar"
                aria-label="Lifetime remaining"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(
                  Math.max(
                    0,
                    Math.min(
                      100,
                      (Date.parse(lifecycle.expiresAt) - Date.now()) / (lifecycle.effectiveTtlSeconds * 10),
                    ),
                  ),
                )}
                className="h-1 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-foreground/55"
                  style={{
                    width: `${Math.max(0, Math.min(100, (Date.parse(lifecycle.expiresAt) - Date.now()) / (lifecycle.effectiveTtlSeconds * 10)))}%`,
                  }}
                />
              </div>
            ) : null}
            <p className="leading-relaxed text-muted-foreground">
              Stopping keeps the disk and the conversation. Send a prompt to resume.
            </p>
          </section>
          {configured && (sandbox.status === "ready" || sandbox.status === "running") && (
            <SandboxCommand sandboxId={sandbox.id} />
          )}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Technical details</summary>
            <div className="pt-4">
              <Facts facts={facts} />
              {settledOutcome(sandbox.status, parseTaskOutcome(sandbox.task_outcome)) && (
                <div className="mt-2 space-y-1">
                  <OutcomeBadge outcome={settledOutcome(sandbox.status, parseTaskOutcome(sandbox.task_outcome))!} />
                  <OutcomeDetail outcome={settledOutcome(sandbox.status, parseTaskOutcome(sandbox.task_outcome))!} />
                </div>
              )}
              {preservationView(sandbox.preservation_note, sandbox.status, sandbox.id, true) && (
                <PreservationNotice
                  preservation={preservationView(sandbox.preservation_note, sandbox.status, sandbox.id, true)!}
                />
              )}
            </div>
          </details>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Usage · <RowCost cost={cost} />
            </summary>
            <div className="pt-3">
              <SandboxCostCard cost={cost} />
            </div>
          </details>

          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Skills</summary>
            <div className="pt-3">
              <InstalledSkills receipts={sandbox.skills} />
            </div>
          </details>

          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Tools</summary>
            <div className="pt-3">
              <AppliedConnections applied={applied} />
            </div>
          </details>
        </SandboxDetailsPanel>
      </div>
    </div>
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
    ["Provider", `your server ${host}`],
    ["Host", host],
    ["Image", image.label, image.detail ?? undefined],
    ...(sandbox.provider_sandbox_id ? [["Container", sandbox.provider_sandbox_id] as Fact] : []),
    ["Harness", HARNESS_LABELS[sandbox.harness] ?? sandbox.harness],
    ["Account", billing.name],
    ["Billing type", billing.billing],
    ["Model", sandbox.model ?? "Provider default"],
    ["Reasoning effort", sandbox.reasoning_effort ?? "Provider default"],
    ["Owner", owner],
    ["Created", formatDate(sandbox.created_at)],
    ...(launchFact ? [launchFact as Fact] : []),
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
    <div data-fit-viewport data-docker-sandbox className="space-y-3 md:space-y-4">
      <ShellPageActions>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 sm:gap-x-3">
            <ShellPageActions slot="status">
              <SandboxState
                viewerOwns={sandbox.owner_id === viewer.id}
                status={sandbox.status}
                statusMessage={sandbox.status_reason}
                readyLabel={parseTaskOutcome(sandbox.task_outcome)?.state === "ready" ? "Finished" : "Waiting for you"}
                idlePaused={sandbox.status_reason === "idle_paused"}
                expiresAt={sandbox.expires_at}
              />
            </ShellPageActions>
          </div>
          <span className="text-xs text-muted-foreground">
            <RowCost cost={cost} />
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
      </ShellPageActions>

      {life.notice && (
        <p className="text-sm text-muted-foreground">
          {life.notice.title} · {life.notice.text}
        </p>
      )}
      <SandboxAttention sandbox={sandbox} viewer={viewer} />

      <p className="text-sm text-muted-foreground">
        {life.remaining} · The time limit cannot be extended on your own server.
      </p>
      <div
        data-fit="body"
        className="grid items-start gap-2 md:gap-6 lg:grid-cols-[minmax(0,1fr)_19.5rem] lg:has-[[data-details-open=false]]:grid-cols-1"
      >
        <div data-fit="column" className="min-w-0 space-y-2 md:space-y-6">
          {ownerCanChange && (sandbox.status === "ready" || sandbox.status === "stopped") && (
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
            <SandboxChat
              sandboxId={sandbox.id}
              initialStatus={sandbox.status}
              provider={sandbox.provider}
              preservationNote={sandbox.preservation_note}
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
          <footer className="flex flex-wrap gap-x-4 gap-y-1 px-4 font-mono text-[11px] text-muted-foreground">
            <span>{sandbox.model ?? "Provider default"}</span>
            <span>
              {sandbox.provider} · {HARNESS_LABELS[sandbox.harness]}
            </span>
            <span>{life.remaining ?? life.lifetime}</span>
            <span>⌘ / Ctrl + Enter to send</span>
          </footer>
        </div>
        <SandboxDetailsPanel>
          {configured && !reasons.exec && (sandbox.status === "ready" || sandbox.status === "running") && (
            <SandboxCommand sandboxId={sandbox.id} />
          )}
          <section className="space-y-3 text-sm">
            <h2 className="text-xs font-medium text-muted-foreground">Agent</h2>
            <Facts
              facts={[
                ["Harness", HARNESS_LABELS[sandbox.harness] ?? sandbox.harness],
                ["Model", sandbox.model ?? "Provider default"],
                ["Effort", sandbox.reasoning_effort ?? "Provider default"],
              ]}
            />
            <h2 className="text-xs font-medium text-muted-foreground">Workspace</h2>
            <BillingAccountSummary account={billing} />
            <h2 className="text-xs font-medium text-muted-foreground">Access</h2>
            <Facts
              facts={[
                ["Started", <CreatedAt key="started" iso={sandbox.created_at} now={Date.now()} />],
                ["Ends", lifecycle.expiresAt ? formatDate(lifecycle.expiresAt) : "No time limit recorded"],
                ["Who can open it", "Owner and organization admins"],
              ]}
            />
            <p className="text-muted-foreground">Sandboxes on your own server do not get tools yet.</p>
          </section>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Technical details</summary>
            <div className="pt-4">
              <Facts facts={facts} />
              {settledOutcome(sandbox.status, parseTaskOutcome(sandbox.task_outcome)) && (
                <div className="mt-2 space-y-1">
                  <OutcomeBadge outcome={settledOutcome(sandbox.status, parseTaskOutcome(sandbox.task_outcome))!} />
                  <OutcomeDetail outcome={settledOutcome(sandbox.status, parseTaskOutcome(sandbox.task_outcome))!} />
                </div>
              )}
              {preservationView(sandbox.preservation_note, sandbox.status, sandbox.id, true) && (
                <PreservationNotice
                  preservation={preservationView(sandbox.preservation_note, sandbox.status, sandbox.id, true)!}
                />
              )}
            </div>
          </details>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Usage · <RowCost cost={cost} />
            </summary>
            <div className="pt-3">
              <SandboxCostCard cost={cost} />
            </div>
          </details>
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
    [
      "Provider",
      sandbox.provider === "boat" ? "Boat cloud" : sandbox.provider === "modal" ? "Modal cloud" : "your server",
    ],
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
          <ShellPageActions>
            <SandboxState
              viewerOwns={false}
              status={sandbox.status}
              idlePaused={sandbox.idlePaused === true}
              readyLabel="Waiting for you"
              expiresAt={sandbox.expiresAt}
            />
          </ShellPageActions>
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
          <dd className="min-w-0 break-words" title={detail}>
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

function BillingAccountSummary({ account }: { account: BillingAccount }) {
  return (
    <p className="text-xs break-words text-muted-foreground [overflow-wrap:anywhere]" data-sandbox-billing-account>
      Account: <span className="font-medium text-foreground">{account.name}</span>
      {account.kindLabel ? ` (${account.kindLabel})` : ""}
    </p>
  );
}
