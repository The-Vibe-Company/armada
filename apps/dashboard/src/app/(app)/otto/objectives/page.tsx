import type { Metadata } from "next";
import Link from "next/link";
import { Empty, PageHeader } from "@/components/page-header";
import { ResourceBrowser, type ResourceRow } from "@/components/resource-browser";
import { Button } from "@/components/ui/button";
import { type ObjectiveList, objectiveRequest } from "@/lib/data/otto-objectives";
import { selectedOrganization } from "@/lib/data/selected-org";
import { CreateObjectiveDialog } from "./objective-forms";

export const metadata: Metadata = { title: "Otto objectives" };
export const dynamic = "force-dynamic";

export default async function ObjectivesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const selected = await selectedOrganization();
  if (!selected)
    return (
      <>
        <PageHeader title="Objectives" description="Durable, private requests for one repository." />
        <Empty title="Choose an organization">
          <Link href="/orgs" className="underline">
            Create or join an organization
          </Link>{" "}
          to save an objective.
        </Empty>
      </>
    );
  let list: ObjectiveList;
  try {
    list = await objectiveRequest<ObjectiveList>(selected.org.id);
  } catch {
    return (
      <>
        <PageHeader title="Objectives" description="Durable, private requests for one repository." />
        <Empty title="Objectives are unavailable">
          Your requests have not been loaded.{" "}
          <Link href="/otto/objectives" className="underline">
            Try again
          </Link>
          .
        </Empty>
      </>
    );
  }
  const rows: ResourceRow[] = list.items.map((objective) => ({
    key: objective.id,
    name: objective.request.split("\n")[0]?.slice(0, 120) || "Objective",
    search: `${objective.request} ${objective.repository}`,
    meta: objective.repository,
    state: <span className="text-sm text-muted-foreground">Saved · private</span>,
    action: (
      <Button asChild variant="outline" size="sm">
        <Link href={`/otto/objectives/${objective.id}`}>Open thread</Link>
      </Button>
    ),
    detail: (
      <div className="space-y-4">
        <p className="whitespace-pre-wrap break-words">{objective.request}</p>
        <Button asChild variant="outline">
          <Link href={`/otto/objectives/${objective.id}`}>Open thread</Link>
        </Button>
      </div>
    ),
  }));
  return (
    <ResourceBrowser
      title="Objectives"
      description="Your private requests and conversations, kept separately for each repository. No engine or worker starts here."
      label="Your objectives"
      initial={typeof query.item === "string" ? query.item : null}
      rows={rows}
      blockers={[]}
      actions={<CreateObjectiveDialog orgId={selected.org.id} repositories={list.repositories} />}
      empty={<Empty title="No objectives yet">Create your first request for a connected repository.</Empty>}
    />
  );
}
