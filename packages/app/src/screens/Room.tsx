// A project's room (THE-1996), the screen the owner works in: its chat, full
// height (THE-2085, after T3 Code's chat view). One 44 px header (the
// project's name, its repository, a pill per state that holds an agent, the
// panel's toggle), the conversation with the project's coordinator taking the
// rest, the owner's field at the bottom, and the panel on the right with its
// tabs (Agents, Pull requests, Rules, Log). The focus goes header, thread,
// field, panel. The sky flies in the hangar only. The sidebar stays.
import type { ProtocolEvent } from "@armada/protocol";
import { m } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DaemonProblem } from "@/components/DaemonProblem";
import { FleetList, groupHeadingId } from "@/components/fleet/FleetList";
import { Page, PageHeader } from "@/components/page";
import { dayIn, fleetItems, type Group, groupCounts, headline, rowTime } from "@/fleet/overview";
import { type Harness, skyProject } from "@/fleet/sky";
import { type FleetState, fleetOf } from "@/fleet/state";
import type { PanelTab } from "@/lib/route";
import { useDaemon } from "@/protocol/store";
import { Asking } from "@/room/Asking";
import { Composer } from "@/room/Composer";
import { type Chat, NO_CHAT, threadItems, useChat, type WhenBusy } from "@/room/chat";
import { coordinatorModel, ownerHistory } from "@/room/compose";
import { Header } from "@/room/Header";
import { HeroHeadline, StarterAsks } from "@/room/Hero";
import { Queued, TurnActions } from "@/room/Live";
import { Log } from "@/room/Log";
import { ticketPrefix } from "@/room/markdown-rules";
import { PANEL_ID, Panel } from "@/room/Panel";
import { Pinned } from "@/room/Pinned";
import { openPullRequests, PullRequests } from "@/room/PullRequests";
import { browserPanel, panelKey, readPanel, showTab, usePanelTab, useSheet, writePanel } from "@/room/panel-rules";
import { Thread, type ThreadControl } from "@/room/Thread";
import { ownerQuestions, starterAsks } from "@/room/view";
import { ProjectRules } from "@/rules/ProjectRules";

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const EMPTY_STATE: FleetState = { sessions: [], tickets: [], pullRequests: [], inbox: [], queue: [], validations: [] };
/** The field's glide from the hero to its dock (THE-2055); the shell's reduced motion turns it off. */
const DOCK = { duration: 0.25, ease: [0.23, 1, 0.32, 1] } as const;

export function Room({
  project: id,
  onReload,
  now: givenNow,
  zone: givenZone,
}: {
  project: string;
  /** Reloads the app: the daemon's problem offers it where reloading helps. */
  onReload?: () => void;
  now?: number;
  zone?: string;
}) {
  const { projects, fleets, logs, status, credentials } = useDaemon();
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
        {onReload && <DaemonProblem onReload={onReload} />}
      </Page>
    );
  return (
    <ProjectRoom
      key={project.id}
      project={project}
      snapshot={fleets[project.id]}
      events={logs[project.id]?.events}
      onReload={onReload}
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
  /** The project's events the subscription applied: the panel's Log. */
  events?: readonly ProtocolEvent[];
  /** Reloads the app: the daemon's problem, when there is one, offers it. */
  onReload?: () => void;
}

function ProjectRoom(props: RoomProps) {
  return <RoomView {...props} chat={useChat(props.project.id)} />;
}

const NO_EVENTS: readonly ProtocolEvent[] = [];

/** Where the panel goes once it shows Agents: a group's heading, or the question's card. */
interface Target {
  to: Group | "question";
  /** Gives it the focus too; a pill on the sheet leaves the focus where it was. */
  focus: boolean;
}

/** The room on a given conversation: what `Room` draws, and what a test renders with a synthetic one. */
export function RoomView({
  project,
  snapshot,
  live,
  now,
  zone,
  model = null,
  events = NO_EVENTS,
  onReload,
  chat,
}: RoomProps & { chat: Chat }) {
  const state = snapshot ? fleetOf(snapshot) : EMPTY_STATE;
  const today = dayIn(now, zone);
  // The fleet changes with the fold and with the viewer's day, not with each millisecond.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `now` only decides the day, which `today` stands for.
  const { items, harness } = useMemo(() => {
    const sky = skyProject(project, state, { now, zone });
    return {
      items: fleetItems([{ id: project.id, state }], { now, zone }),
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
  const prs = useMemo(() => openPullRequests(state, items), [state, items]);
  const groupOf = (ticket: string): Group | null => groups.get(ticket) ?? null;
  const harnessOf = (ticket: string) => harness.get(ticket) ?? null;
  const counts = groupCounts(items);
  const column = useRef<HTMLDivElement>(null);
  const questions = ownerQuestions(state);
  const pinned = questions[0];
  const history = useMemo(() => ownerHistory(chat.items), [chat.items]);
  // The coordinator's turn (THE-2052): null on a daemon older than CHAT_LIVE_MINOR, which shows nothing live.
  const turn = chat.live?.turn ?? null;
  const busy = turn !== null && turn.state !== "idle";
  const shown = useMemo(() => threadItems(chat.items, chat.live), [chat.items, chat.live]);
  const stop = chat.stop;
  // The thread's scroll (THE-2054): a message the thread shows is pinned near its top; the field pages it.
  const thread = useRef<ThreadControl>(null);
  const send = chat.send;
  const sendAndAnchor = useCallback(
    async (body: string, whenBusy?: WhenBusy) => {
      await (whenBusy ? send(body, whenBusy) : send(body));
      if (whenBusy !== "queue") thread.current?.anchor(body);
    },
    [send],
  );
  // Nothing said yet (THE-2055): the hero holds the thread's place, the field centred under it.
  const hero = chat.status === "ready" && shown.length === 0 && !busy && !chat.queued?.length && !chat.problem;
  const asks = useMemo(() => starterAsks(state), [state]);
  // Only leaving the hero glides the field (its first Send); the hero arriving with the first reading does not.
  const [dock, setDock] = useState({ hero, glides: 0 });
  if (dock.hero !== hero) setDock({ hero, glides: dock.glides + (dock.hero ? 1 : 0) });
  const closed = !live || chat.status !== "ready" || !chat.coordinator;

  // The panel (THE-2085): its tab in the address, its width and whether it is open kept on this machine;
  // on a narrow window a sheet, closed until asked for. An address naming a tab opens it.
  const sheet = useSheet();
  const routed = usePanelTab();
  const tab: PanelTab = routed ?? "agents";
  const [store, setStore] = useState(() => {
    const held = readPanel(browserPanel());
    return routed ? { ...held, open: true } : held;
  });
  const [sheetOpen, setSheetOpen] = useState(false);
  const open = sheet ? sheetOpen : (store.open ?? true);
  const panel = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const setOpen = useCallback(
    (next: boolean) => {
      // The panel leaving with the focus in it hands the focus back to its toggle.
      if (!next && panel.current?.contains(document.activeElement)) toggle.current?.focus();
      if (sheet) return setSheetOpen(next);
      setStore((held) => {
        const kept = { ...held, open: next };
        writePanel(browserPanel(), kept);
        return kept;
      });
    },
    [sheet],
  );
  const close = useCallback(() => setOpen(false), [setOpen]);
  const setWidth = useCallback((width: number, done: boolean) => {
    setStore((held) => {
      const kept = { ...held, width };
      if (done) writePanel(browserPanel(), kept);
      return kept;
    });
  }, []);
  const [target, setTarget] = useState<Target | null>(null);
  const goTo = (to: Target["to"], focus: boolean) => {
    showTab(project.id, "agents");
    setOpen(true);
    setTarget({ to, focus });
  };
  // Once Agents shows, the panel goes to the group's heading (or the question's card), within itself only.
  useEffect(() => {
    if (!target || !open || tab !== "agents") return;
    const root = panel.current;
    const el =
      target.to === "question"
        ? root?.querySelector<HTMLElement>("[data-pinned] button, [data-pinned] input")
        : root?.querySelector<HTMLElement>(`#${groupHeadingId(target.to)}`);
    const scroller = root?.querySelector<HTMLElement>('[role="tabpanel"]');
    if (!el || !scroller) return;
    scroller.scrollTop = target.to === "question" ? 0 : el.offsetTop;
    if (target.focus) el.focus({ preventScroll: true });
    setTarget(null);
  }, [target, open, tab]);
  // ⌘. toggles the panel, ⌘1 to ⌘4 pick its tab while it is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = panelKey(e);
      if (!key || (key.kind === "tab" && !open)) return;
      e.preventDefault();
      if (key.kind === "toggle") setOpen(!open);
      else showTab(project.id, key.tab);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen, project.id]);

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
      <Header
        project={project}
        counts={snapshot ? counts : null}
        readAt={state.readAt}
        now={now}
        open={open}
        panel={PANEL_ID}
        toggle={toggle}
        onToggle={() => setOpen(!open)}
        onPill={(group) => goTo(group, !sheet)}
      />
      {onReload && <DaemonProblem onReload={onReload} className="mx-4 mt-3 flex-none" />}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div ref={column} className="flex min-w-0 flex-1 flex-col">
          {/* The same places in both layouts: the field stays the same element, and glides to its dock. */}
          {hero ? (
            <HeroHeadline sentence={snapshot ? headline(counts) : null} />
          ) : (
            <Thread
              control={thread}
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
          )}
          {chat.problem && chat.items.length > 0 && (
            <p
              role="alert"
              className="m-0 mx-auto w-full max-w-[calc(var(--chat-content-max-width)+1.5rem)] flex-none px-3 pb-2 text-body text-amber sm:max-w-[calc(var(--chat-content-max-width)+6rem)] sm:px-12"
            >
              {chat.problem}
            </p>
          )}
          <Queued items={chat.queued ?? []} />
          {/* The question's card is in the panel's Agents; while that is not on screen, the field says it waits. */}
          {pinned && !(open && tab === "agents") && (
            <Asking item={pinned} waiting={questions.length} onAnswer={() => goTo("question", true)} />
          )}
          <m.div layout="position" layoutDependency={dock.glides} transition={DOCK} className="flex-none" data-dock>
            <Composer
              project={project.id}
              send={sendAndAnchor}
              onPage={(direction) => thread.current?.page(direction)}
              busy={busy}
              primary={busy && stop ? (field) => <TurnActions field={field} stop={stop} /> : undefined}
              restore={chat.withdrawn ?? null}
              disabled={closed}
              hint={hint}
              history={history}
              model={model}
            />
          </m.div>
          {hero && (
            <StarterAsks
              asks={asks}
              send={chat.send}
              disabled={closed}
              sent={() => column.current?.querySelector<HTMLTextAreaElement>("[data-composer] textarea")?.focus()}
            />
          )}
        </div>
        <div ref={panel} className="contents">
          <Panel
            open={open}
            sheet={sheet}
            tab={tab}
            width={store.width}
            onTab={(t) => showTab(project.id, t)}
            onWidth={setWidth}
            onClose={close}
          >
            {tab === "agents" ? (
              <>
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
                {snapshot ? (
                  <FleetList
                    items={items}
                    harnessOf={harnessOf}
                    repository={project.repository}
                    prefixes={prefixes}
                    now={now}
                    zone={zone}
                  />
                ) : (
                  <Reading />
                )}
              </>
            ) : tab === "prs" ? (
              snapshot ? (
                <PullRequests prs={prs} repository={project.repository} />
              ) : (
                <Reading />
              )
            ) : tab === "rules" ? (
              snapshot ? (
                <div className="px-4 py-3">
                  <ProjectRules state={snapshot.state} />
                </div>
              ) : (
                <Reading />
              )
            ) : (
              <Log events={events} now={now} zone={zone} />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Reading() {
  return <p className="m-0 px-4 py-3 text-body text-text-3">Reading the project's log.</p>;
}
