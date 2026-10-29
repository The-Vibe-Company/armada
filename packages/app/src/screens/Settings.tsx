import { CoordinatorKey } from "@/components/CoordinatorKey";
import { DaemonProblem } from "@/components/DaemonProblem";
import { Dot, Page, PageHeader } from "@/components/page";

/** The settings (`#/settings`, reached from the sidebar's bottom): the coordinator's model, its key form unchanged. */
export function Settings({ address, onReload }: { address: string; onReload: () => void }) {
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
      <DaemonProblem onReload={onReload} />
      <CoordinatorKey />
    </Page>
  );
}
