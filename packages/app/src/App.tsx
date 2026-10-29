import { lazy, Suspense } from "react";
import { Shell } from "@/components/shell/Shell";
import type { DaemonClient } from "@/protocol/client";
import { DaemonProvider } from "@/protocol/store";
import { routeOf, useHash } from "@/room/route";
import { Home } from "@/screens/Home";

// The sky's story page (`?story=sky`), loaded only behind its flag: never in the first load.
const SkyStory = lazy(() => import("@/screens/SkyStory").then((m) => ({ default: m.SkyStory })));
// A project's room (`#/projects/<id>`) and a session's page (`#/sessions/<ticket>`): loaded when opened.
const Room = lazy(() => import("@/screens/Room").then((m) => ({ default: m.Room })));
const SessionPlaceholder = lazy(() =>
  import("@/room/SessionPlaceholder").then((m) => ({ default: m.SessionPlaceholder })),
);

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
  const route = routeOf(useHash());
  return (
    <DaemonProvider client={client}>
      <Shell>
        {story === "sky" ? (
          <Suspense>
            <SkyStory />
          </Suspense>
        ) : route.screen === "room" ? (
          <Suspense>
            <Room project={route.project} />
          </Suspense>
        ) : route.screen === "session" ? (
          <Suspense>
            <SessionPlaceholder ticket={route.ticket} />
          </Suspense>
        ) : (
          <Home address={address} onReload={onReload} />
        )}
      </Shell>
    </DaemonProvider>
  );
}
