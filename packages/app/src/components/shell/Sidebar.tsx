import { lazy, type ReactNode, Suspense } from "react";
import { sessionsInFlight } from "@/fleet/sessions";
import { fleetOf } from "@/fleet/state";
import { projectHref, useRoute } from "@/lib/route";
import type { ConnectionStatus } from "@/protocol/client";
import { useDaemon } from "@/protocol/store";
import { useSessionRoute } from "@/session/route";
import type { Badges } from "./Activity";
import { Count } from "./Count";
import { Logo } from "./Logo";

const item =
  "flex h-item flex-none items-center gap-2 whitespace-nowrap rounded-sm px-2 text-text-2 transition-colors hover:bg-item-hover hover:text-text";
const current = "aria-[current=page]:bg-item-current aria-[current=page]:text-text";

// Each project's coordinator state and unread count, after the first paint: off the first-load budget.
const Activity = lazy(() => import("./Activity"));

/**
 * The sidebar (design/dashboard-v7): the mark, the hangar, one line per
 * project with its coordinator's state as T3 Code's pills (Working, Awaiting
 * input, Failed), what it said since the owner last read its room (THE-2054)
 * and its sessions in flight (once its folded state arrived, so nothing counts
 * up on the first paint), the app's own settings (Plugins, Settings) and the
 * live reading of the daemon.
 */
export function Sidebar() {
  const { projects, fleets, status } = useDaemon();
  const route = useRoute();
  // A session's page is none of the sections: the hangar is not the current page there.
  const session = useSessionRoute();
  const home = route.kind === "home" && !session;
  // The room on screen reads its own conversation, and its project has nothing unread.
  const open = route.kind === "project" && !session ? route.id : null;
  const lines = (badges?: Badges): ReactNode =>
    projects?.map((p) => {
      const fleet = fleets[p.id];
      const state = fleet ? fleetOf(fleet) : null;
      return (
        <a
          key={p.id}
          href={projectHref(p.id)}
          className={`${item} ${current}`}
          aria-current={(route.kind === "project" || route.kind === "rules") && route.id === p.id ? "page" : undefined}
          title={p.repository}
        >
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
          {badges?.(p.id, state)}
          {state && <Sessions count={sessionsInFlight(state)} />}
        </a>
      );
    });
  return (
    <aside
      aria-label="Sidebar"
      className="flex w-sidebar flex-none flex-col gap-0.5 overflow-y-auto overflow-x-hidden border-line border-r bg-side px-2.5 py-3"
    >
      <div className="flex h-9 items-center gap-2 px-1.5 pt-1 pb-2.5">
        <Logo />
        <span className="font-semibold text-sub">Armada</span>
      </div>
      <nav aria-label="Sections" className="flex flex-col gap-0.5">
        <a href="#/" className={`${item} ${current}`} aria-current={home ? "page" : undefined}>
          <span className="min-w-0 flex-1 truncate">Hangar</span>
        </a>
      </nav>
      <nav aria-labelledby="sidebar-projects" className="flex flex-col gap-0.5">
        <div id="sidebar-projects" className="px-2 pt-4.5 pb-1.5 font-medium text-label text-text-3">
          Projects
        </div>
        {projects === null && <div className="px-2 py-1.5 text-small text-text-3">Waiting for the daemon</div>}
        {projects?.length === 0 && <div className="px-2 py-1.5 text-small text-text-3">No project yet</div>}
        <Suspense fallback={lines()}>
          <Activity open={open}>{lines}</Activity>
        </Suspense>
      </nav>
      <span className="flex-1" />
      <nav aria-label="Armada" className="flex flex-col gap-0.5">
        <a
          href="#/plugins"
          className={`${item} ${current}`}
          aria-current={route.kind === "plugins" ? "page" : undefined}
        >
          <span className="min-w-0 flex-1 truncate">Plugins</span>
        </a>
        <a
          href="#/settings"
          className={`${item} ${current}`}
          aria-current={route.kind === "settings" ? "page" : undefined}
        >
          <span className="min-w-0 flex-1 truncate">Settings</span>
        </a>
      </nav>
      <Live status={status} />
    </aside>
  );
}

function Sessions({ count }: { count: number }) {
  return (
    <>
      <Count value={count} />
      <span className="sr-only"> {count === 1 ? "session" : "sessions"} in flight</span>
    </>
  );
}

const LIVE: Record<ConnectionStatus, { label: string; dot: string; ink: string }> = {
  connecting: { label: "Connecting to the daemon", dot: "bg-text-3", ink: "text-text-3" },
  live: { label: "Live", dot: "bg-green", ink: "text-text-3" },
  reconnecting: { label: "Reconnecting", dot: "bg-amber", ink: "text-amber" },
  refused: { label: "Refused by the daemon", dot: "bg-red", ink: "text-red" },
};

/** The live reading: a still dot in the connection's state, beside its word. */
function Live({ status }: { status: ConnectionStatus }) {
  const { label, dot, ink } = LIVE[status];
  return (
    <div role="status" className={`flex items-center gap-2 whitespace-nowrap px-2 pt-2.5 pb-0.5 text-heading ${ink}`}>
      <span aria-hidden className={`size-1.5 flex-none rounded-full ${dot}`} />
      <span>{label}</span>
    </div>
  );
}
