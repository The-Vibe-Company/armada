import type { OttoOrphan, OttoResource } from "@armada/core";
import { BoxIcon, CircleDotIcon, CornerDownRightIcon, GitPullRequestIcon, RadarIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Empty, PageHeader } from "@/components/page-header";
import { ResourceBrowser, type ResourceRow, ResourceSelectLink } from "@/components/resource-browser";
import { PanelSection, RowTag, StateCell } from "@/components/state-cell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { loadOtto } from "@/lib/data/otto";
import {
  countLabel,
  type OttoSnapshot,
  type OttoTreeNode,
  orphansOfDay,
  ottoTree,
  ownerLook,
  prHead,
  pullRequestUrl,
  reasonText,
  resourceKey,
  resourceName,
  taskKey,
  taskObservedAt,
  taskTitle,
  unknownLabel,
} from "@/lib/otto";
import { relativeAge } from "@/lib/relative-time";

export const metadata: Metadata = { title: "Otto" };
export const dynamic = "force-dynamic";
const DESCRIPTION = "What Otto observed in the repository: tasks, who owns what, and today's orphans. Read-only.";

const FAILURES = {
  "not-observed": "Otto observes no repository for this organization on this Armada server.",
  unauthorized: "The Armada server refused this session. Sign in again.",
  unavailable: "The Armada server could not read Otto's observations right now.",
  unreachable: "The Armada server is unreachable.",
  malformed: "The Armada server sent an unexpected answer.",
} as const;

export default async function OttoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [data, query] = await Promise.all([loadOtto(), searchParams]);
  const header = <PageHeader title="Otto" description={DESCRIPTION} />;
  if (data.state === "no-org")
    return (
      <>
        {header}
        <Empty title="No organization yet">
          <Link href="/orgs" className="underline">
            Create an organization
          </Link>{" "}
          to see what Otto observes.
        </Empty>
      </>
    );
  const failure =
    data.state === "not-configured"
      ? "The Armada server is not configured for this dashboard."
      : data.read.state === "ready"
        ? null
        : FAILURES[data.read.state];
  if (data.state !== "read" || data.read.state !== "ready")
    return (
      <>
        {header}
        <Alert
          variant={data.state === "read" && data.read.state !== "not-observed" ? "destructive" : "default"}
          data-otto-unavailable
        >
          <AlertTitle>Otto is unavailable</AlertTitle>
          <AlertDescription>
            {failure}
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href="/otto">Try again</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </>
    );
  const snapshot = data.read.snapshot;
  const now = Date.now();
  const { nodes, unlinked } = ottoTree(snapshot.tasks, snapshot.resources);
  const keys = new Set<string>();
  const rows: ResourceRow[] = [];
  const push = (row: ResourceRow) => {
    if (keys.has(row.key)) return;
    keys.add(row.key);
    rows.push(row);
  };
  for (const node of nodes) {
    push(taskRow(node, snapshot, now));
    for (const resource of node.resources) push(resourceRow(resource, snapshot, data.viewerId, now, true));
  }
  for (const resource of unlinked) push(resourceRow(resource, snapshot, data.viewerId, now, false));
  return (
    <ResourceBrowser
      title="Otto"
      description={DESCRIPTION}
      label="Tasks and what they own"
      rows={rows}
      blockers={[]}
      initial={typeof query.item === "string" ? query.item : null}
      notices={<Summary snapshot={snapshot} now={now} />}
      empty={
        <Empty title="Nothing observed yet" icon={<RadarIcon />}>
          {snapshot.githubCompleteness === "complete"
            ? "The last complete listing of the repository found no open pull request and no live sandbox."
            : `The open pull requests are ${unknownLabel(snapshot.observedAt, now).toLowerCase()}: an empty list here does not mean there are none.`}
        </Empty>
      }
      footer={<Orphans orphans={snapshot.orphans} keys={keys} snapshot={snapshot} now={now} />}
    />
  );
}

function Summary({ snapshot, now }: { snapshot: OttoSnapshot; now: number }) {
  const summary = snapshot.summary;
  const observed = snapshot.observedAt ? relativeAge(snapshot.observedAt, now) : null;
  const facts: [string, ReactNode][] = [
    ["Repository", snapshot.repository ?? <Unknown key="r">{unknownLabel(null, now)}</Unknown>],
    [
      "Open pull requests",
      typeof summary?.openPrCount === "number" ? (
        summary.openPrCount
      ) : (
        <Unknown key="p">{unknownLabel(snapshot.observedAt, now)}</Unknown>
      ),
    ],
    [
      "Orphans",
      typeof summary?.orphanCount === "number" ? (
        countLabel(summary.orphanCount)
      ) : (
        <Unknown key="o">{unknownLabel(snapshot.observedAt, now)}</Unknown>
      ),
    ],
    [
      "Repository listing",
      snapshot.githubCompleteness === "complete" && observed ? (
        `Complete, ${observed}`
      ) : (
        <Unknown key="l">{unknownLabel(snapshot.observedAt, now)}</Unknown>
      ),
    ],
  ];
  return (
    <section aria-label="Observation" className="space-y-3" data-otto-summary>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border shadow-xs lg:grid-cols-4">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0 space-y-1 bg-card px-4 py-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-sm font-medium break-words tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {(summary?.limitations.length || snapshot.truncated || summary?.fleetCoverage === "armada_registered_only") && (
        <Alert>
          <AlertTitle>What Otto cannot see</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-0.5 pl-4">
              {summary?.fleetCoverage === "armada_registered_only" && (
                <li>Only sandboxes registered in Armada are observed; other machines are not counted.</li>
              )}
              {summary?.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
              {snapshot.truncated && <li>The lists were cut at their first pages: more items exist than shown.</li>}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}

function Unknown({ children }: { children: ReactNode }) {
  return (
    <span data-unknown className="text-warning">
      {children}
    </span>
  );
}

function taskRow(node: OttoTreeNode, snapshot: OttoSnapshot, now: number): ResourceRow {
  const { task } = node;
  const observedAt = taskObservedAt(node, snapshot.observedAt);
  const prs = node.resources.filter((resource) => resource.kind === "pr").length;
  const sandboxes = node.resources.length - prs;
  const owns = node.resources.length
    ? [plural(prs, "pull request"), plural(sandboxes, "sandbox")].filter(Boolean).join(", ")
    : "Nothing linked";
  const state =
    task.state === "open" ? { tone: "info" as const, label: "Open" } : { tone: "neutral" as const, label: "Unknown" };
  return {
    key: taskKey(task),
    name: `#${task.issueNumber} ${taskTitle(task) ?? "(title not observed)"}`,
    search: `${task.issueNumber} ${task.title} task issue`,
    mark: <CircleDotIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
    tags: <RowTag>Task</RowTag>,
    meta: `Expected proof unknown · ${observedAt ? `observed ${relativeAge(observedAt, now) ?? "at an unknown time"}` : "never observed"}`,
    state: (
      <StateCell
        tone={state.tone}
        label={state.label}
        detail={task.state === "open" ? undefined : unknownLabel(observedAt, now)}
        data-unknown={task.state === "open" ? undefined : ""}
      />
    ),
    fact: owns,
    attrs: { "data-otto-task": String(task.issueNumber) },
    panelAttrs: { "data-otto-panel": taskKey(task) },
    subtitle: `Task from issue #${task.issueNumber}`,
    detail: (
      <div className="space-y-5">
        <PanelSection title="State">
          <Facts
            items={[
              [
                "Deduced state",
                task.state === "open" ? "Open" : <Unknown key="s">{unknownLabel(observedAt, now)}</Unknown>,
              ],
              [
                "Expected proof",
                <Unknown key="proof">Unknown · the server does not report the proof a task expects yet</Unknown>,
              ],
              [
                "Evidence",
                <code key="fact" className="text-xs break-all">
                  {task.factId}
                </code>,
              ],
            ]}
          />
        </PanelSection>
        <PanelSection title="Owns">
          {node.resources.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pull request or sandbox is linked to this task.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {node.resources.map((resource) => (
                <li key={resourceKey(resource)} className="flex min-w-0 items-center gap-2">
                  <ResourceIcon resource={resource} />
                  <ResourceSelectLink item={resourceKey(resource)} className="truncate underline underline-offset-4">
                    {resourceName(resource)}
                  </ResourceSelectLink>
                </li>
              ))}
            </ul>
          )}
        </PanelSection>
        <p className="text-xs text-muted-foreground">
          A task is linked from its pull request's branch name; that is a candidate, not proof that anyone works on it.
        </p>
      </div>
    ),
  };
}

function resourceRow(
  resource: OttoResource,
  snapshot: OttoSnapshot,
  viewerId: string,
  now: number,
  child: boolean,
): ResourceRow {
  const owner = ownerLook(resource, viewerId);
  const head = prHead(resource);
  const url = pullRequestUrl(snapshot.repository, resource);
  const status = typeof resource.evidence.status === "string" ? resource.evidence.status : null;
  const launchBranch = typeof resource.evidence.launchBranch === "string" ? resource.evidence.launchBranch : null;
  const task =
    resource.taskIssue === null
      ? "No task linked"
      : child
        ? `Task #${resource.taskIssue}`
        : `Task #${resource.taskIssue} (not in the task list)`;
  const observed = resource.observedAt ? relativeAge(resource.observedAt, now) : null;
  return {
    key: resourceKey(resource),
    name: resourceName(resource),
    search: `${resource.kind} ${resource.externalId} ${resourceName(resource)} ${head?.ref ?? ""} ${owner.label} ${resource.taskIssue ?? ""}`,
    mark: (
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
        {child && <CornerDownRightIcon aria-hidden className="size-3.5" />}
        <ResourceIcon resource={resource} />
      </span>
    ),
    tags: <RowTag>{resource.kind === "pr" ? "Pull request" : "Sandbox"}</RowTag>,
    meta: (
      <>
        {/* The task column is hidden on narrow lists: the relationship is then said here, in words. */}
        <span className="@3xl:hidden">{task} · </span>
        {resource.kind === "pr"
          ? (head?.ref ?? "Branch unknown")
          : `Launched on ${launchBranch ?? "an unknown branch"}`}
        {` · ${observed ? `observed ${observed}` : "never observed"}`}
      </>
    ),
    state: (
      <StateCell
        tone={owner.tone}
        label={owner.label}
        detail={reasonText(resource.reason)}
        data-unknown={resource.owner.state === "unknown" ? "" : undefined}
      />
    ),
    fact: task,
    attrs: { "data-otto-resource": resourceKey(resource) },
    panelAttrs: { "data-otto-panel": resourceKey(resource) },
    subtitle: `${resource.kind === "pr" ? "Pull request" : "Sandbox"} · observed ${observed ?? "never"}`,
    detail: (
      <div className="space-y-5">
        <PanelSection title="Owner">
          <Facts
            items={[
              [
                "Owner",
                resource.owner.state === "unknown" ? (
                  <Unknown key="o">{unknownLabel(resource.observedAt, now)}</Unknown>
                ) : (
                  owner.label
                ),
              ],
              ["Why", reasonText(resource.reason)],
              ["Task", task],
              ["Observed", observed ?? <Unknown key="w">{unknownLabel(null, now)}</Unknown>],
            ]}
          />
        </PanelSection>
        {resource.kind === "pr" ? (
          <PanelSection title="Head">
            <Facts
              items={[
                ["Repository", head?.repo ?? <Unknown key="r">{unknownLabel(resource.observedAt, now)}</Unknown>],
                ["Branch", head?.ref ?? <Unknown key="b">{unknownLabel(resource.observedAt, now)}</Unknown>],
                [
                  "Commit",
                  head?.sha ? (
                    <code key="s" className="text-xs break-all">
                      {head.sha}
                    </code>
                  ) : (
                    <Unknown key="s">{unknownLabel(resource.observedAt, now)}</Unknown>
                  ),
                ],
              ]}
            />
            {url && (
              <a href={url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-4">
                Open on GitHub
              </a>
            )}
          </PanelSection>
        ) : (
          <PanelSection title="Sandbox">
            <Facts
              items={[
                ["Status", status ?? <Unknown key="s">{unknownLabel(resource.observedAt, now)}</Unknown>],
                ["Launch branch", launchBranch ?? <Unknown key="l">{unknownLabel(resource.observedAt, now)}</Unknown>],
                [
                  "Current branch",
                  <Unknown key="c">{unknownLabel(null, now)} · the launch branch is not the current checkout</Unknown>,
                ],
              ]}
            />
            <Link
              href={`/sandboxes/${encodeURIComponent(resource.externalId)}`}
              className="text-sm underline underline-offset-4"
            >
              Open the sandbox
            </Link>
          </PanelSection>
        )}
      </div>
    ),
  };
}

function Orphans({
  orphans,
  keys,
  snapshot,
  now,
}: {
  orphans: OttoOrphan[];
  keys: Set<string>;
  snapshot: OttoSnapshot;
  now: number;
}) {
  const { confirmed, candidates, day } = orphansOfDay(orphans);
  const item = (orphan: OttoOrphan) => {
    const key = resourceKey(orphan.resource);
    return (
      <li key={key} className="flex min-w-0 flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <ResourceIcon resource={orphan.resource} />
          {keys.has(key) ? (
            <ResourceSelectLink item={key} className="truncate underline-offset-4 hover:underline">
              {resourceName(orphan.resource)}
            </ResourceSelectLink>
          ) : (
            <span className="truncate">{resourceName(orphan.resource)}</span>
          )}
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground sm:ml-auto">
          {orphan.state === "orphan" ? "No live owner" : unknownLabel(orphan.resource.observedAt, now)}
        </span>
      </li>
    );
  };
  return (
    <section aria-labelledby="otto-orphans" className="space-y-2 pt-4" data-otto-orphans>
      <div className="space-y-0.5">
        <h2 id="otto-orphans" className="text-base font-semibold">
          Orphans of the day{day ? ` (${day}, UTC)` : ""}
        </h2>
        <p className="text-sm text-muted-foreground">
          Open pull requests with no live owner and live sandboxes with no task. A candidate whose owner is unknown is
          not a confirmed orphan.
        </p>
      </div>
      {orphans.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          {snapshot.githubCompleteness === "complete"
            ? "No orphan or candidate in the last complete observation."
            : `Orphans are ${unknownLabel(snapshot.observedAt, now).toLowerCase()}.`}
        </p>
      ) : (
        <div className="space-y-3">
          {confirmed.length > 0 && (
            <ul aria-label="Confirmed orphans" className="divide-y rounded-xl border bg-card shadow-xs">
              {confirmed.map(item)}
            </ul>
          )}
          {candidates.length > 0 && (
            <div className="space-y-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">
                Candidates, owner unknown ({candidates.length})
              </h3>
              <ul aria-label="Orphan candidates" className="divide-y rounded-xl border bg-card shadow-xs">
                {candidates.map(item)}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ResourceIcon({ resource }: { resource: OttoResource }) {
  const Icon = resource.kind === "pr" ? GitPullRequestIcon : BoxIcon;
  return <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

function plural(count: number, word: string) {
  if (count === 0) return "";
  return `${count} ${word}${count === 1 ? "" : word.endsWith("x") ? "es" : "s"}`;
}
