import { lazy, Suspense } from "react";
import { Shell } from "@/components/shell/Shell";
import { useRoute } from "@/lib/route";
import type { DaemonClient } from "@/protocol/client";
import { DaemonProvider } from "@/protocol/store";
import { Hangar } from "@/screens/Hangar";
import { useSessionRoute } from "@/session/route";

// The sky's story page (`?story=sky`), loaded only behind its flag: never in the first load.
const SkyStory = lazy(() => import("@/screens/SkyStory").then((m) => ({ default: m.SkyStory })));
// A project's room (`#/projects/<id>`), loaded when opened.
const Room = lazy(() => import("@/screens/Room").then((m) => ({ default: m.Room })));
// Project rules are fetched when opened, alongside the other project screens.
const Project = lazy(() => import("@/screens/Project").then((m) => ({ default: m.Project })));
// A session's page, fetched when a row opens it: off the first-load budget.
const Session = lazy(() => import("@/screens/Session").then((m) => ({ default: m.Session })));
// The notifications (THE-2055): every screen hears them, off the first load, once the shell is drawn.
const Notifications = lazy(() => import("@/notify/Notifications").then((m) => ({ default: m.Notifications })));
// The app's own settings: off the first load (perf-budget.json), fetched when opened.
const Settings = lazy(() => import("@/screens/Settings").then((m) => ({ default: m.Settings })));

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
        ) : route.kind === "settings" ? (
          // The shell stays while the screen's code arrives.
          <Suspense fallback={null}>
            <Settings section={route.section} address={address} onReload={onReload} />
          </Suspense>
        ) : route.kind === "project" ? (
          <Suspense>
            <Room project={route.id} />
          </Suspense>
        ) : route.kind === "rules" ? (
          <Suspense>
            <Project id={route.id} onReload={onReload} />
          </Suspense>
        ) : (
          <Hangar onReload={onReload} />
        )}
        {/* A coordinator's answer or a question for the owner, from a room not on screen (THE-2055). */}
        <Suspense fallback={null}>
          <Notifications />
        </Suspense>
      </Shell>
    </DaemonProvider>
  );
}
