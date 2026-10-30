import { CoordinatorKey } from "@/components/CoordinatorKey";
import { DaemonProblem } from "@/components/DaemonProblem";
import { Dot, Page, PageHeader } from "@/components/page";
import { NotificationSetting } from "@/notify/NotificationSetting";

/**
 * The settings (`#/settings`, reached from the sidebar's bottom): the coordinator's model, its key form unchanged,
 * then the OS notifications' switch (THE-2055).
 */
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
        quiet="The model your coordinators think with, and how Armada tells you a room needs you. Both stay on this device."
      />
      <DaemonProblem onReload={onReload} />
      <CoordinatorKey />
      <NotificationSetting />
    </Page>
  );
}
