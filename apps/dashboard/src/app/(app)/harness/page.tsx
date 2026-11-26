import { CircleAlertIcon, InfoIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AddAccountDialog, ModelsOverview } from "@/components/model-accounts";
import { Empty, PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  type AccountList,
  listSelectedAccounts,
  readAccountUsage,
  readConnectionTestChoices,
} from "@/lib/data/model-accounts";
import { selectedOrganization } from "@/lib/data/selected-org";

import { HARNESS_PATH } from "@/lib/model-accounts";

export const metadata: Metadata = { title: "Models" };
export const dynamic = "force-dynamic";
export const maxDuration = 320;

/**
 * The coding harnesses (Claude Code, Codex) and the subscriptions they run on (#805). Only that: a person's own
 * provider keys (Boat, Modal) are in Settings, next to the organization's sandbox providers.
 */
export default async function HarnessPage() {
  const [selected, accounts] = await Promise.all([selectedOrganization(), listSelectedAccounts()]);
  const now = Date.now();

  return (
    <>
      <PageHeader
        title="Models"
        description="Subscriptions and API keys that power Claude Code, Codex, and OpenCode when sandboxes launch."
        inlineActions
      >
        {selected && accounts.state === "ready" && (
          <AddAccountDialog orgId={selected.org.id} orgName={selected.org.name} isAdmin={selected.role === "admin"} />
        )}
      </PageHeader>

      <Suspense fallback={null}>
        <HarnessSections list={accounts} selected={selected} now={now} />
      </Suspense>
    </>
  );
}

async function HarnessSections({
  list,
  selected,
  now,
}: {
  list: AccountList;
  selected: Awaited<ReturnType<typeof selectedOrganization>>;
  now: number;
}) {
  if (list.state === "no-org" || !selected)
    return (
      <Empty
        title="No organization yet"
        action={
          <Button asChild>
            <Link href="/orgs">Choose an organization</Link>
          </Button>
        }
      >
        Create or join an organization before connecting model accounts.
      </Empty>
    );
  if (list.state === "not-configured")
    return (
      <Alert role="status">
        <InfoIcon />
        <AlertTitle>Account management is not ready here</AlertTitle>
        <AlertDescription>
          <p>Ask an Armada administrator to finish setup, then reload Models.</p>
          <Button asChild variant="outline" size="sm" className="mt-2">
            <a href={HARNESS_PATH}>Reload Models</a>
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (list.state === "legacy")
    return (
      <Alert data-accounts="legacy">
        <CircleAlertIcon />
        <AlertTitle>Account management needs an update</AlertTitle>
        <AlertDescription>
          <p>
            Your existing subscriptions and API keys can still launch agents. Ask an Armada administrator to update
            Armada before adding or managing accounts here.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-2">
            <Link href="/snapshots">Choose a snapshot</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (list.state === "error")
    return (
      <Alert variant="destructive" data-accounts="error">
        <CircleAlertIcon />
        <AlertTitle>Model accounts could not be loaded</AlertTitle>
        <AlertDescription>
          <p>
            Check your connection and reload Models. If this continues, ask an Armada administrator to check account
            management.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-2">
            <a href={HARNESS_PATH}>Reload Models</a>
          </Button>
        </AlertDescription>
      </Alert>
    );

  const [usage, testChoices] = await Promise.all([
    readAccountUsage(list.accounts),
    readConnectionTestChoices(list.accounts),
  ]);
  return (
    <ModelsOverview
      accounts={list.accounts}
      defaults={list.defaults}
      orgId={selected.org.id}
      orgName={selected.org.name}
      isAdmin={selected.role === "admin"}
      usage={usage}
      now={now}
      testChoices={testChoices}
      emptyAction={
        <AddAccountDialog
          orgId={selected.org.id}
          orgName={selected.org.name}
          isAdmin={selected.role === "admin"}
          triggerLabel="Add account"
          triggerVariant="outline"
        />
      }
    />
  );
}
