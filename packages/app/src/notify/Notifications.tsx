// The app's notifications (THE-2055), mounted once beside every screen: it
// hears every project's live turn and folded inbox through the one daemon
// client, and hands `rules.ts` the window's focus, the room on screen and the
// Settings switch. Toasts sit at the bottom right of a focused window, gone
// after a few seconds; "Open the room" opens it.
import { CircleCheck, MessageCircleQuestionMark, X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { fleetOf } from "@/fleet/state";
import { projectHref, routeOf } from "@/lib/route";
import { useDaemon, useDaemonClient } from "@/protocol/store";
import { createNotifier, NOTICE_TITLE, type Notice, type OsNotificationClass } from "./rules";
import { osNotificationsOn } from "./settings";
import { reveal, setBadge } from "./shell";

/** How long a toast stays when nobody acts on it. */
export const TOAST_MS = 6_000;
const FADE = { duration: 0.15, ease: [0.23, 1, 0.32, 1] } as const;

/** The project whose room the window shows, if it is visible: the hash names it, a session's page does not. */
export function roomOnScreen(hash: string, visible: boolean): string | null {
  const route = routeOf(hash);
  return visible && route.kind === "project" ? route.id : null;
}

const openRoom = (project: string) => {
  reveal();
  window.location.hash = projectHref(project);
};

/** Runs `run` after `ms`; returns its cancel. A test's page hands its own clock. */
export type Schedule = (run: () => void, ms: number) => () => void;
const windowSchedule: Schedule = (run, ms) => {
  const timer = window.setTimeout(run, ms);
  return () => window.clearTimeout(timer);
};

export function Notifications({ schedule = windowSchedule }: { schedule?: Schedule }) {
  const client = useDaemonClient();
  const { projects, fleets } = useDaemon();
  const names = useRef(new Map<string, string>());
  names.current = new Map((projects ?? []).map((p) => [p.id, p.name]));
  const [toasts, setToasts] = useState<Notice[]>([]);
  const notifier = useMemo(
    () =>
      createNotifier({
        onScreen: () => roomOnScreen(window.location.hash, document.visibilityState === "visible"),
        focused: () => document.visibilityState === "visible" && document.hasFocus(),
        osEnabled: () => osNotificationsOn(),
        Notification:
          typeof Notification === "undefined" ? undefined : (Notification as unknown as OsNotificationClass),
        nameOf: (project) => names.current.get(project) ?? project,
        read: (project) => client.request({ type: "chat.read", project }).then((r) => r.items),
        toast: (notice) => setToasts((list) => [...list.filter((t) => t.tag !== notice.tag), notice]),
        badge: setBadge,
        open: openRoom,
      }),
    [client],
  );
  useEffect(() => client.chat((frame) => notifier.frame(frame)), [client, notifier]);
  useEffect(() => {
    for (const [project, snapshot] of Object.entries(fleets)) notifier.inbox(project, fleetOf(snapshot).inbox);
  }, [fleets, notifier]);
  useEffect(() => {
    const focus = () => notifier.focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [notifier]);
  // A room opened another way makes its toasts old news.
  useEffect(() => {
    const change = () => {
      const room = roomOnScreen(window.location.hash, true);
      setToasts((list) => (list.some((t) => t.project === room) ? list.filter((t) => t.project !== room) : list));
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  const close = (tag: string) => setToasts((list) => list.filter((t) => t.tag !== tag));
  return <Toasts toasts={toasts} close={close} open={openRoom} schedule={schedule} />;
}

/** The toasts, newest at the bottom; each closes itself after TOAST_MS unless hovered or focused. */
export function Toasts({
  toasts,
  close,
  open,
  schedule = windowSchedule,
}: {
  toasts: readonly Notice[];
  close: (tag: string) => void;
  open: (project: string) => void;
  schedule?: Schedule;
}) {
  return (
    // One live region, always there, so each toast that arrives in it is announced; not a landmark of its own.
    <div
      aria-live="polite"
      aria-relevant="additions"
      data-toasts
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
    >
      <AnimatePresence initial={false}>
        {toasts.map((notice) => (
          <m.div
            key={`${notice.tag}:${notice.line}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={FADE}
          >
            <Toast
              notice={notice}
              schedule={schedule}
              close={() => close(notice.tag)}
              open={() => {
                close(notice.tag);
                open(notice.project);
              }}
            />
          </m.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function Toast({
  notice,
  schedule,
  close,
  open,
}: {
  notice: Notice;
  schedule: Schedule;
  close: () => void;
  open: () => void;
}) {
  const [held, setHeld] = useState(false);
  const shut = useRef(close);
  shut.current = close;
  useEffect(() => {
    if (held) return;
    return schedule(() => shut.current(), TOAST_MS);
  }, [held, schedule]);
  const id = useId();
  const Icon = notice.kind === "answered" ? CircleCheck : MessageCircleQuestionMark;
  return (
    <article
      aria-labelledby={`${id}-title`}
      data-toast={notice.kind}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className="pointer-events-auto flex gap-3 rounded-card bg-card p-3.5 shadow-pop"
    >
      <Icon
        aria-hidden
        size={16}
        className={notice.kind === "answered" ? "mt-0.5 flex-none text-green" : "mt-0.5 flex-none text-amber"}
      />
      <div className="min-w-0 flex-1">
        <p id={`${id}-title`} className="m-0 font-medium text-body text-text">
          {NOTICE_TITLE[notice.kind]}
        </p>
        <p className="m-0 text-body text-text-2">
          <span className="text-text-soft">{notice.name}</span>
          {notice.line && <span className="block truncate">{notice.line}</span>}
        </p>
        <Button onClick={open} className="mt-2.5">
          Open the room
        </Button>
      </div>
      <button
        type="button"
        onClick={close}
        aria-label="Dismiss"
        className="grid size-6 flex-none cursor-pointer place-items-center rounded-sm text-text-3 hover:text-text"
      >
        <X aria-hidden size={14} />
      </button>
    </article>
  );
}
