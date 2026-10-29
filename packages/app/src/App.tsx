import { lazy, Suspense } from "react";
import { Shell } from "@/components/shell/Shell";
import { useRoute } from "@/lib/route";
import type { DaemonClient } from "@/protocol/client";
import { DaemonProvider } from "@/protocol/store";
import { Hangar } from "@/screens/Hangar";
import { Project } from "@/screens/Project";
import { Settings } from "@/screens/Settings";
import { useSessionRoute } from "@/session/route";

// The sky's story page (`?story=sky`), loaded only behind its flag: never in the first load.
const SkyStory = lazy(() => import("@/screens/SkyStory").then((m) => ({ default: m.SkyStory })));
// A session's page, fetched when a row opens it: off the first-load budget.
const Session = lazy(() => import("@/screens/Session").then((m) => ({ default: m.Session })));
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
  const session = useSessionRoute();
  return (
    <DaemonProvider client={client}>
      <Shell>
        {story === "sky" ? (
          <Suspense>
            <SkyStory />
          </Suspense>
        ) : session ? (
          <Suspense fallback={null}>
            <Session key={session.ticket} ticket={session.ticket} tab={session.tab} />
          </Suspense>
        ) : route.kind === "plugins" ? (
          // The shell stays while the screen's code arrives.
          <Suspense fallback={null}>
            <Plugins />
          </Suspense>
        ) : route.kind === "project" ? (
          <Project id={route.id} onReload={onReload} />
        ) : route.kind === "settings" ? (
          <Settings address={address} onReload={onReload} />
        ) : (
          <Hangar onReload={onReload} />
        )}
      </Shell>
    </DaemonProvider>
  );
}
