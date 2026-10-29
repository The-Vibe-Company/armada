import { Shell } from "@/components/shell/Shell";
import { useRoute } from "@/lib/route";
import type { DaemonClient } from "@/protocol/client";
import { DaemonProvider } from "@/protocol/store";
import { Home } from "@/screens/Home";
import { Project } from "@/screens/Project";

export function App({ client, address, onReload }: { client: DaemonClient; address: string; onReload: () => void }) {
  const route = useRoute();
  return (
    <DaemonProvider client={client}>
      <Shell>
        {route.kind === "project" ? (
          <Project id={route.id} onReload={onReload} />
        ) : (
          <Home address={address} onReload={onReload} />
        )}
      </Shell>
    </DaemonProvider>
  );
}
