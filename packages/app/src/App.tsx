import { lazy, Suspense } from "react";
import { Shell } from "@/components/shell/Shell";
import { useRoute } from "@/lib/route";
import type { DaemonClient } from "@/protocol/client";
import { DaemonProvider } from "@/protocol/store";
import { Hangar } from "@/screens/Hangar";
import { Project } from "@/screens/Project";
import { Settings } from "@/screens/Settings";

// The sky's story page (`?story=sky`), loaded only behind its flag: never in the first load.
const SkyStory = lazy(() => import("@/screens/SkyStory").then((m) => ({ default: m.SkyStory })));

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
  return (
    <DaemonProvider client={client}>
      <Shell>
        {story === "sky" ? (
          <Suspense>
            <SkyStory />
          </Suspense>
        ) : (
          <Screen address={address} onReload={onReload} />
        )}
      </Shell>
    </DaemonProvider>
  );
}

/** The screen the address's route names (src/lib/route.ts). */
function Screen({ address, onReload }: { address: string; onReload: () => void }) {
  const route = useRoute();
  switch (route.screen) {
    case "project":
      return <Project key={route.id} id={route.id} onReload={onReload} />;
    case "settings":
      return <Settings address={address} onReload={onReload} />;
    default:
      return <Hangar onReload={onReload} />;
  }
}
