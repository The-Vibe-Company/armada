import { lazy, Suspense } from "react";
import { Shell } from "@/components/shell/Shell";
import type { DaemonClient } from "@/protocol/client";
import { DaemonProvider } from "@/protocol/store";
import { Home } from "@/screens/Home";
import { useSessionRoute } from "@/session/route";

// The sky's story page (`?story=sky`), loaded only behind its flag: never in the first load.
const SkyStory = lazy(() => import("@/screens/SkyStory").then((m) => ({ default: m.SkyStory })));
// A session's page, fetched when a row opens it: off the first-load budget.
const Session = lazy(() => import("@/screens/Session").then((m) => ({ default: m.Session })));

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
        ) : (
          <Home address={address} onReload={onReload} />
        )}
      </Shell>
    </DaemonProvider>
  );
}
