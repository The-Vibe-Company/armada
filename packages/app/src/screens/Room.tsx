// A project's room (THE-1996), the screen the owner works in, after the
// direction kept with the owner (`.aeom/direction/room.html`, "hangar-sky-mix"):
// the v7 anatomy (the facts line, the 22 px title, the quiet line), the sky as
// a 200 px band where the project's agents fly, the question waiting for the
// owner pinned under it, then the conversation with the project's coordinator
// taking the width, the owner's field fixed at the bottom. The agents' rail
// slides in from the right at a third of the width. The sidebar stays.
import { AnimatePresence } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dot, Page, PageHeader } from "@/components/page";
import { dayIn, fleetItems, type Group, groupCounts, headline, rowTime } from "@/fleet/overview";
import { type Harness, skyProject } from "@/fleet/sky";
import { type FleetState, fleetOf } from "@/fleet/state";
import { rulesHref } from "@/lib/route";
import { cn } from "@/lib/utils";
import { useDaemon } from "@/protocol/store";
import { Composer } from "@/room/Composer";
import { type Chat, NO_CHAT, threadItems, useChat } from "@/room/chat";
import { coordinatorModel, ownerHistory } from "@/room/compose";
import { Queued, TurnActions } from "@/room/Live";
import { ticketPrefix } from "@/room/markdown-rules";
import { Pinned } from "@/room/Pinned";
import { RAIL_ID, Rail } from "@/room/Rail";
import { Thread } from "@/room/Thread";
import { ownerQuestions } from "@/room/view";
import { Sky } from "@/sky/Sky";

/** Below this window width the rail starts closed: a third of it would leave the conversation too narrow. */
const RAIL_MIN_WINDOW = 1100;
const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const EMPTY_STATE: FleetState = { sessions: [], tickets: [], pullRequests: [], inbox: [], queue: [], validations: [] };

export function Room({
  project: id,
  now: givenNow,
  zone: givenZone,
}: {
  project: string;
  now?: number;
  zone?: string;
}) {
  const { projects, fleets, status, credentials } = useDaemon();
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const project = projects?.find((p) => p.id === id);
  if (!project)
    return (
      <Page>
        <PageHeader
          facts={<span className="contents text-body">Project</span>}
          title={id}
          quiet={projects === null ? "Waiting for the daemon to list its projects." : "The daemon has no such project."}
        />
      </Page>
    );
  return (
    <ProjectRoom
      key={project.id}
      project={project}
      snapshot={fleets[project.id]}
      live={status === "live"}
      model={coordinatorModel(credentials)}
      now={givenNow ?? clock}
      zone={givenZone ?? viewerZone()}
    />
  );
}

interface RoomProps {
  project: { id: string; name: string; repository: string };
  snapshot: { state: unknown } | undefined;
  live: boolean;
  now: number;
  zone: string;
  /** The coordinator's model, when the daemon says it. */
  model?: string | null;
}

function ProjectRoom(props: RoomProps) {
  return <RoomView {...props} chat={useChat(props.project.id)} />;
}

/** The room on a given conversation: what `Room` draws, and what a test renders with a synthetic one. */
export function RoomView({ project, snapshot, live, now, zone, model = null, chat }: RoomProps & { chat: Chat }) {
  const state = snapshot ? fleetOf(snapshot) : EMPTY_STATE;
  const today = dayIn(now, zone);
  // The fleet and the sky change with the fold and with the viewer's day, not with each millisecond.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `now` only decides the day, which `today` stands for.
  const { items, sky, harness } = useMemo(() => {
    const sky = skyProject(project, state, { now, zone });
    return {
      items: fleetItems([{ id: project.id, state }], { now, zone }),
      sky,
      harness: new Map<string, Harness | null>(sky.agents.map((a) => [a.ticket, a.harness])),
    };
  }, [project, state, today, zone]);
  const groups = useMemo(() => new Map(items.map((i) => [i.ticket, i.group])), [items]);
  // The teams the project's tickets belong to: an id under one of them links in the conversation.
  const prefixes = useMemo(
    () =>
      [...new Set([...state.tickets.map((t) => t.id), ...state.sessions.map((s) => s.ticket)].map(ticketPrefix))]
        .sort()
        .join(" "),
    [state],
  );
  const groupOf = (ticket: string): Group | null => groups.get(ticket) ?? null;
  const harnessOf = (ticket: string) => harness.get(ticket) ?? null;
  const counts = groupCounts(items);
  const flying = counts.blocked + counts.you + counts.running + counts.ready;
  // Open by default (the direction), unless the window is too narrow to keep the conversation readable beside it.
  const [open, setOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= RAIL_MIN_WINDOW);
  const toggle = useRef<HTMLButtonElement>(null);
  const questions = ownerQuestions(state);
  const pinned = questions[0];
  const history = useMemo(() => ownerHistory(chat.items), [chat.items]);
  // The coordinator's turn (THE-2052): null on a daemon older than CHAT_LIVE_MINOR, which shows nothing live.
  const turn = chat.live?.turn ?? null;
  const busy = turn !== null && turn.state !== "idle";
  const shown = useMemo(() => threadItems(chat.items, chat.live), [chat.items, chat.live]);
  const stop = chat.stop;

  const hint =
    chat.status === "unavailable"
      ? NO_CHAT
      : !live
        ? "Waiting for the daemon."
        : chat.coordinator === false
          ? "No coordinator runs for this project yet: save its model key in Settings, then restart the daemon."
          : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-room={project.id}>
      <div className="flex-none border-line border-b px-7 pt-5 pb-4">
        <PageHeader
          facts={
            <span className="contents text-body">
              <span className="font-mono text-meta text-text-3">{project.repository}</span>
              {snapshot && (
                <>
                  <Dot />
                  <Fact n={flying}>{flying === 1 ? "agent" : "agents"} in flight</Fact>
                  <Dot />
                  <Fact n={counts.running}>moving on their own</Fact>
                  <Dot />
                  <Fact n={counts.ready} tone="text-green">
                    ready to merge
                  </Fact>
                  <Dot />
                  <Fact n={counts.merged}>merged today</Fact>
                  <span aria-hidden className="mx-1 h-4 w-px bg-line-strong" />
                  <Fact n={counts.blocked} tone="text-red">
                    blocked
                  </Fact>
                  <Dot />
                  <Fact n={questions.length + counts.you} tone="text-amber">
                    waiting for you
                  </Fact>
                </>
              )}
              {Object.entries(state.readAt ?? {}).map(([provider, at]) => {
                const age = now - Date.parse(at);
                if (age <= 180_000) return null;
                const name = provider === "linear" ? "Linear" : provider === "github" ? "GitHub" : provider;
                return (
                  <span key={provider} className="inline-flex items-center gap-2 text-meta text-text-3">
                    <Dot />
                    <span title={at}>
                      {name} last read {Math.floor(age / 60_000)} min ago
                    </span>
                  </span>
                );
              })}
              <a href={rulesHref(project.id)} className="ml-auto rounded-sm px-1.5 text-text-2 hover:text-text">
                Rules
              </a>
              <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                aria-controls={open ? RAIL_ID : undefined}
                ref={toggle}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-text-2 hover:text-text"
              >
                Agents <span className="font-mono text-meta tnum">{flying}</span>
                <span aria-hidden>{open ? "›" : "‹"}</span>
              </button>
            </span>
          }
          title={project.name}
          quiet={snapshot ? headline(counts) : "Reading the project's log."}
        />
      </div>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className={cn("flex min-w-0 flex-1 flex-col", open && "mr-[33.333%]")}>
          <Sky projects={[sky]} size="band" className="border-line border-b" />
          {pinned && (
            <Pinned
              key={pinned.id}
              item={pinned}
              waiting={questions.length}
              title={state.sessions.find((s) => s.ticket === pinned.ticket)?.title ?? null}
              harness={harnessOf(pinned.ticket)}
              time={pinned.at ? rowTime(pinned.at, now, zone) : ""}
              answer={chat.answer}
            />
          )}
          <Thread
            items={shown}
            turn={turn}
            started={chat.live?.started ?? null}
            project={project.id}
            repository={project.repository}
            prefixes={prefixes}
            groupOf={groupOf}
            now={now}
            zone={zone}
            empty={
              chat.problem ??
              (chat.status === "reading" && live
                ? "Reading the conversation."
                : "Nothing said yet. Tell the coordinator what to do.")
            }
          />
          {chat.problem && chat.items.length > 0 && (
            <p
              role="alert"
              className="m-0 mx-auto w-full max-w-[calc(var(--chat-content-max-width)+1.5rem)] flex-none px-3 pb-2 text-body text-amber sm:max-w-[calc(var(--chat-content-max-width)+6rem)] sm:px-12"
            >
              {chat.problem}
            </p>
          )}
          <Queued items={chat.queued ?? []} />
          <Composer
            project={project.id}
            send={chat.send}
            busy={busy}
            primary={busy && stop ? (field) => <TurnActions field={field} stop={stop} /> : undefined}
            disabled={!live || chat.status !== "ready" || !chat.coordinator}
            hint={hint}
            history={history}
            model={model}
          />
        </div>
        <AnimatePresence initial={false}>
          {open && (
            <Rail
              items={items}
              harnessOf={harnessOf}
              now={now}
              zone={zone}
              onClose={() => {
                setOpen(false);
                // The rail's close button leaves with it: the focus goes back to the toggle.
                toggle.current?.focus();
              }}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** A number of the facts line, in its state's colour when it has one. */
function Fact({ n, tone, children }: { n: number; tone?: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5" data-fact>
      <b className={cn("font-medium font-mono text-body tnum", tone && n > 0 ? tone : "text-text")}>{n}</b>
      {children}
    </span>
  );
}
