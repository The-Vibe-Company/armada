import { CircleAlertIcon } from "lucide-react";
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
} from "@/lib/data/model-accounts";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { HARNESS_LABELS } from "@/lib/labels";
import {
  type AuthCapabilities,
  accountsFor,
  HARNESS_ORDER,
  HARNESS_PATH,
  kindFor,
  launchDefault,
  orderAccounts,
} from "@/lib/model-accounts";

export const metadata: Metadata = { title: "Harness" };
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
        title="Harness"
        description="The subscriptions Claude Code and Codex run on. Each launch bills the one it names."
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
      <Empty title="No organization yet">
        <Link className="underline" href="/orgs">
          Create an organization
        </Link>{" "}
        to add a subscription.
      </Empty>
    );
  if (list.state === "not-configured")
    return (
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertDescription>The Armada server is not configured: subscriptions cannot be managed here.</AlertDescription>
      </Alert>
    );
  if (list.state === "legacy")
    return (
      <Alert data-accounts="legacy">
        <CircleAlertIcon />
        <AlertTitle>This Armada server predates named accounts</AlertTitle>
        <AlertDescription>
          Your saved subscriptions and API keys still launch. Update the server to name them, add more and choose one
          per launch.
        </AlertDescription>
      </Alert>
    );
  if (list.state === "error")
    return (
      <Alert variant="destructive" data-accounts="error">
        <CircleAlertIcon />
        <AlertTitle>Subscriptions could not be loaded</AlertTitle>
        <AlertDescription>
          <p>{list.message}</p>
          <Button asChild variant="outline" size="sm" className="mt-2">
            <Link href={HARNESS_PATH}>Try again</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );

  const usage = await readAccountUsage(list.accounts);
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
          emptyAction={
            <AddAccountDialog
              orgId={selected.org.id}
              orgName={selected.org.name}
              isAdmin={selected.role === "admin"}
              capabilities={capabilities}
              initialKind={kindFor(harness)}
              triggerLabel={`Add a ${HARNESS_LABELS[harness]} subscription`}
              triggerVariant="outline"
            />
          }
        />
      ))}
    </>
  );
}
