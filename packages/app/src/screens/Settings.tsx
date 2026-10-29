import { CoordinatorKey } from "@/components/CoordinatorKey";
import { Dot, Page, PageHeader } from "@/components/page";

/** The settings (`#/settings`, reached from the sidebar's bottom): the coordinator's model, its key form unchanged. */
export function Settings({ address }: { address: string }) {
  return (
    <Page>
      <PageHeader
        facts={
          <>
            <span>Daemon</span>
            <Dot />
            <span className="font-mono">{address}</span>
          </>
        }
        title="Settings"
        quiet="The model your coordinators think with. Its key stays on this device."
      />
      <CoordinatorKey />
    </Page>
  );
}
