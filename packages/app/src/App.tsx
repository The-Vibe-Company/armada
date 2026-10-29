import { Shell } from "@/components/shell/Shell";
import type { DaemonClient } from "@/protocol/client";
import { DaemonProvider } from "@/protocol/store";
import { Home } from "@/screens/Home";

export function App({ client, address, onReload }: { client: DaemonClient; address: string; onReload: () => void }) {
  return (
    <DaemonProvider client={client}>
      <Shell>
        <Home address={address} onReload={onReload} />
      </Shell>
    </DaemonProvider>
  );
}
