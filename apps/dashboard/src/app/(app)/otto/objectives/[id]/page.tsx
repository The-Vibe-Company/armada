import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Empty, PageHeader } from "@/components/page-header";
import { isUuid } from "@/lib/action";
import { ObjectiveError, type ObjectiveThread, objectiveRequest } from "@/lib/data/otto-objectives";
import { selectedOrganization } from "@/lib/data/selected-org";
import { InterviewPanel } from "../interview-panel";
import { ObjectiveMessageForm } from "../objective-forms";

import { TicketGraphForm } from "./ticket-graph-form";
import { TicketGraphPanel } from "./ticket-graph-panel";

export const metadata: Metadata = { title: "Objective thread" };
export const dynamic = "force-dynamic";

/** Downstream Otto panels join this shell; the durable request is not a completion claim. */
export default async function ObjectivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const selected = await selectedOrganization();
  if (!selected || !isUuid(id)) notFound();
  let thread: ObjectiveThread;
  try {
    thread = await objectiveRequest<ObjectiveThread>(selected.org.id, `/${id}`);
  } catch (error) {
    if (error instanceof ObjectiveError && error.status === 404) notFound();
    return (
      <>
        <PageHeader title="Objective thread" description="Your private request and messages." />
        <Empty title="Thread unavailable">
          No thread content was loaded.{" "}
          <Link href="/otto/objectives" className="underline">
            Return to objectives
          </Link>
          .
        </Empty>
      </>
    );
  }
  return (
    <>
      <Link
        href="/otto/objectives"
        className="mb-4 inline-block text-sm text-muted-foreground underline underline-offset-4"
      >
        All objectives
      </Link>
      <PageHeader
        title="Objective thread"
        description={`${thread.objective.repository} · Private to you in ${selected.org.name}`}
      />
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <section aria-labelledby="objective-request-title" className="rounded-lg border p-5">
          <h2 id="objective-request-title" className="mb-3 text-sm font-medium text-muted-foreground">
            Original request
          </h2>
          <p className="whitespace-pre-wrap break-words">{thread.objective.request}</p>
          <time className="mt-4 block text-xs text-muted-foreground" dateTime={thread.objective.created_at}>
            {new Date(thread.objective.created_at).toLocaleString("en-US", { timeZone: "UTC" })} UTC
          </time>
        </section>
        <section aria-labelledby="objective-messages-title" className="space-y-4">
          <h2 id="objective-messages-title" className="font-medium">
            Messages
          </h2>
          {thread.messages.length ? (
            <ol className="divide-y rounded-lg border">
              {thread.messages.map((message) => (
                <li key={message.id} className="space-y-2 p-5">
                  <p className="whitespace-pre-wrap break-words">{message.body}</p>
                  <time dateTime={message.created_at} className="text-xs text-muted-foreground">
                    {new Date(message.created_at).toLocaleString("en-US", { timeZone: "UTC" })} UTC
                  </time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">No follow-up messages yet.</p>
          )}
        </section>
        <TicketGraphPanel orgId={selected.org.id} id={id} />
        <TicketGraphForm orgId={selected.org.id} id={id} />
        <Link href="/otto/your-turn" className="inline-block underline underline-offset-4">
          Answer pending questions in Your turn
        </Link>
        <InterviewPanel orgId={selected.org.id} id={id} />
        <ObjectiveMessageForm orgId={selected.org.id} id={id} />
      </div>
    </>
  );
}
