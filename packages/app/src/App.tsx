import { lazy, Suspense } from "react";
import { Shell } from "@/components/shell/Shell";
import { useRoute } from "@/lib/route";
import type { DaemonClient } from "@/protocol/client";
import { DaemonProvider } from "@/protocol/store";
import { Home } from "@/screens/Home";

// A screen of the app's own settings: off the first load (perf-budget.json), fetched when opened.
const Plugins = lazy(() => import("@/screens/Plugins").then((m) => ({ default: m.Plugins })));

export function App({ client, address, onReload }: { client: DaemonClient; address: string; onReload: () => void }) {
  const route = useRoute();
  return (
    <DaemonProvider client={client}>
      <Shell>
        {route === "plugins" ? (
          // The shell stays while the screen's code arrives.
          <Suspense fallback={null}>
            <Plugins />
          </Suspense>
        ) : (
          <Home address={address} onReload={onReload} />
        )}
      </Shell>
    </DaemonProvider>
  );
}
