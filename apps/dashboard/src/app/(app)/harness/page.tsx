import { CircleAlertIcon, InfoIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AddAccountDialog, HarnessAccounts } from "@/components/model-accounts";
import { Empty, PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  type AccountList,
  listSelectedAccounts,
  readAccountUsage,
  readAuthCapabilities,
  readConnectionTestChoices,
} from "@/lib/data/model-accounts";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { HARNESS_LABELS } from "@/lib/labels";
import {
  type AuthCapabilities,
  accountsFor,
  HARNESS_ORDER,
  HARNESS_PATH,
  KIND_INFO,
  kindFor,
  launchDefault,
  orderAccounts,
} from "@/lib/model-accounts";

export const metadata: Metadata = { title: "Models" };
export const dynamic = "force-dynamic";

/**
 * The coding harnesses (Claude Code, Codex) and the subscriptions they run on (#805). Only that: a person's own
 * provider keys (Boat, Modal) are in Settings, next to the organization's sandbox providers.
 */
export default async function HarnessPage() {
  await requireViewer();
  const selected = await selectedOrganization();
  const [accounts, capabilities] = await Promise.all([
    listSelectedAccounts(),
    selected ? readAuthCapabilities(selected.org.id) : null,
  ]);
  const now = Date.now();

  return (
    <>
      <PageHeader
        title="Models"
        description="Subscriptions, API keys and model connections for your coding agents. Each launch names its account."
      >
        {selected && accounts.state === "ready" && (
          <AddAccountDialog
            orgId={selected.org.id}
            orgName={selected.org.name}
            isAdmin={selected.role === "admin"}
            capabilities={capabilities}
          />
        )}
      </PageHeader>

      <HarnessSections list={accounts} selected={selected} capabilities={capabilities} now={now} />
    </>
  );
}

async function HarnessSections({
  list,
  selected,
  capabilities,
  now,
}: {
  list: AccountList;
  selected: Awaited<ReturnType<typeof selectedOrganization>>;
  capabilities: AuthCapabilities | null;
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
            <Link href="/environments">Choose a snapshot</Link>
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
    <>
      {HARNESS_ORDER.map((harness) => (
        <HarnessAccounts
          key={harness}
          harness={harness}
          harnessLabel={HARNESS_LABELS[harness]}
          resolved={launchDefault(list.accounts, harness, now)}
          accounts={orderAccounts(accountsFor(list.accounts, harness), now)}
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
              capabilities={capabilities}
              initialKind={kindFor(harness)}
              triggerLabel={
                KIND_INFO[kindFor(harness)].billing === "subscription"
                  ? `Add a ${HARNESS_LABELS[harness]} subscription`
                  : `Add an ${HARNESS_LABELS[harness]} key`
              }
              triggerVariant="outline"
            />
          }
        />
      ))}
    </>
  );
}
