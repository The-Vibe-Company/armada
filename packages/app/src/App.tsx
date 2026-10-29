import { lazy, Suspense } from "react";
import { Shell } from "@/components/shell/Shell";
import { useRoute } from "@/lib/route";
import type { DaemonClient } from "@/protocol/client";
import { DaemonProvider } from "@/protocol/store";
import { Home } from "@/screens/Home";
import { Project } from "@/screens/Project";

// The sky's story page (`?story=sky`), loaded only behind its flag: never in the first load.
const SkyStory = lazy(() => import("@/screens/SkyStory").then((m) => ({ default: m.SkyStory })));
// A screen of the app's own settings: off the first load (perf-budget.json), fetched when opened.
const Plugins = lazy(() => import("@/screens/Plugins").then((m) => ({ default: m.Plugins })));

export function App({
  client,
  address,
  onReload,
  story,
}: {
  client: DaemonClient;
  address: string;
  onReload: () => void;
  story?: string | null;
}) {
  const route = useRoute();
  return (
    <DaemonProvider client={client}>
      <Shell>
        {story === "sky" ? (
          <Suspense>
            <SkyStory />
          </Suspense>
        ) : route.kind === "plugins" ? (
          // The shell stays while the screen's code arrives.
          <Suspense fallback={null}>
            <Plugins />
          </Suspense>
        ) : route.kind === "project" ? (
          <Project id={route.id} onReload={onReload} />
        ) : (
          <Home address={address} onReload={onReload} />
        )}
      </Shell>
    </DaemonProvider>
  );
}
