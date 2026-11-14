import type { OttoWait } from "@armada/core";
import { Empty, PageHeader } from "@/components/page-header";
import { selectedOrganization } from "@/lib/data/selected-org";
import { QuestionPanel } from "./question-panel";
import { waitRequest } from "./request";
export const metadata = { title: "Your turn" };
export const dynamic = "force-dynamic";
export default async function YourTurnPage() {
  const selected = await selectedOrganization();
  if (!selected) return <Empty title="Choose an organization">Select an organization to see your questions.</Empty>;
  let items: OttoWait[];
  try {
    items = (await waitRequest<{ items: OttoWait[] }>(selected.org.id)).items;
  } catch {
    return <Empty title="Your turn is unavailable">No questions were loaded. Refresh to try again.</Empty>;
  }
  return (
    <>
      <PageHeader
        title="Your turn"
        description="Decisions and missing access. Other objectives can continue while these wait."
      />
      <div className="mx-auto max-w-3xl space-y-4">
        {items.length ? (
          items.map((wait) => <QuestionPanel key={wait.id} wait={wait} orgId={selected.org.id} />)
        ) : (
          <Empty title="No questions recorded">
            This inbox shows questions recorded by Otto’s server tools. Automatic interview question creation is not
            connected yet; an empty inbox does not mean your objective is unblocked.
          </Empty>
        )}
      </div>
    </>
  );
}
