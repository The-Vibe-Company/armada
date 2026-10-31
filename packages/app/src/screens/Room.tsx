// A project's room (THE-1996), the screen the owner works in: its chat, full
// height (THE-2085, after T3 Code's chat view). One 44 px header (the
// project's name, its repository, a pill per state that holds an agent, the
// panel's toggle), the conversation with the project's coordinator taking the
// rest, the owner's field at the bottom, and the panel on the right with its
// tabs (Agents, Pull requests, Rules, Log). The focus goes header, thread,
// field, panel. The sky flies in the hangar only. The sidebar stays. An agent
// named by the address (`&agent=`, THE-2089) takes the chat's place with its
// page, the chat kept as it was under it; the panel's Agents tab hops from one
// agent to the next, the Coordinator first, by a click or `↑` `↓` (`K` `J`),
// and Escape returns to the chat.
import type { ProtocolEvent } from "@armada/protocol";
import { MessagesSquare } from "lucide-react";
import { m } from "motion/react";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DaemonProblem } from "@/components/DaemonProblem";
import { FleetList } from "@/components/fleet/FleetList";
import { Page, PageHeader } from "@/components/page";
import { dayIn, fleetItems, GROUPS, type Group, groupCounts, headline, rowTime } from "@/fleet/overview";
import { type Harness, skyProject } from "@/fleet/sky";
import { type FleetState, fleetOf } from "@/fleet/state";
import { roomHref } from "@/lib/route";
import { cn } from "@/lib/utils";
import { useDaemon } from "@/protocol/store";
import { AgentLane } from "@/room/AgentLane";
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
import { PullRequests, useMerging } from "@/room/PullRequests";
import { agentHref, agentKey, agentStep, showAgent, useRoomAgent } from "@/room/panel-rules";
import { forgeReads, openPullRequests } from "@/room/pr-rules";
import { Thread, type ThreadControl } from "@/room/Thread";
import { useRoomPanel } from "@/room/use-panel";
import { ownerQuestions, starterAsks } from "@/room/view";
import { ProjectRules } from "@/rules/ProjectRules";
import { NeedsArmada } from "@/settings/NeedsArmada";
import { linearNeedsSignIn } from "@/settings/needs-armada";

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
  // THE-2071: signed out, a Linear project without a key of its own waits for the organization's.
  const daemon = useDaemon();
  const needsSignIn = linearNeedsSignIn(daemon, project.id, state.readAt);
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
  // The panel's Merge (THE-2086): a message to the coordinator, held as "Merging…" until it is answered.
  const merging = useMerging({ prs, send: sendAndAnchor, turn, items: chat.items });
  const reads = forgeReads(daemon.providers);

  // The panel (THE-2085): its state, its keys and where a pill or Answer takes it.
  const side = useRoomPanel(project.id);
  const { sheet, tab, open } = side;

  // The agent whose page holds the lane (THE-2089); the chat when none.
  const agent = useRoomAgent();
  const lane = useRef<HTMLElement>(null);
  const chatHref = roomHref(project.id, tab);
  // The agents in the panel's order, the Coordinator (the chat) before them: what ↑ and ↓ walk.
  const order = useMemo(() => GROUPS.flatMap((g) => items.filter((i) => i.group === g).map((i) => i.ticket)), [items]);
  useAgentKeys({ project: project.id, agent, order, panel: side.root, lane, agents: tab === "agents", sheet, open });
  // Back to the chat with the focus lost in the lane that left: the Coordinator's row takes it, or the field.
  const lastAgent = useRef(agent);
  useEffect(() => {
    const was = lastAgent.current;
    lastAgent.current = agent;
    if (was === null || agent !== null) return;
    const held = document.activeElement;
    if (held && held !== document.body) return;
    const row = open && tab === "agents" ? side.root.current?.querySelector<HTMLElement>("[data-coordinator] a") : null;
    (row ?? column.current?.querySelector<HTMLElement>("[data-composer] textarea"))?.focus({ preventScroll: true });
  }, [agent, open, tab, side.root]);
  // A row followed on the sheet shows its agent and closes the sheet over it.
  const opened = () => {
    if (sheet) side.setOpen(false);
  };

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
        toggle={side.toggle}
        onToggle={() => side.setOpen(!open)}
        onPill={(group) => (group === "ready" ? side.show("prs") : side.goTo(group, !sheet))}
        onChat={agent === null ? undefined : () => window.location.assign(chatHref)}
      />
      {needsSignIn && (
        <div className="flex-none px-7 pt-2">
          <NeedsArmada why="Linear has no key for this project." />
        </div>
      )}
      {onReload && <DaemonProblem onReload={onReload} className="mx-4 mt-3 flex-none" />}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* The chat stays mounted under an agent's page: its scroll, its field's draft and its turn are kept. */}
          <div
            ref={column}
            inert={agent !== null}
            className={cn("flex min-h-0 min-w-0 flex-1 flex-col", agent !== null && "invisible")}
          >
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
                away={agent !== null}
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
              <Asking item={pinned} waiting={questions.length} onAnswer={() => side.goTo("question", true)} />
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
          {agent !== null && (
            <AgentLane
              lane={lane}
              project={project}
              ticket={agent}
              state={state}
              events={events}
              chatHref={chatHref}
              read={snapshot !== undefined}
              now={now}
              zone={zone}
            />
          )}
        </div>
        <div ref={side.root} className="contents">
          <Panel
            open={open}
            sheet={sheet}
            tab={tab}
            counts={snapshot ? { prs: prs.length } : undefined}
            width={side.width}
            onTab={side.setTab}
            onWidth={side.setWidth}
            onClose={() => side.setOpen(false)}
          >
            {tab === "agents" ? (
              <>
                <CoordinatorRow href={agentHref(project.id, null)} current={agent === null} onOpen={opened} />
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
                    hrefOf={(ticket) => agentHref(project.id, ticket)}
                    current={agent}
                    onOpen={opened}
                  />
                ) : (
                  <Reading />
                )}
              </>
            ) : tab === "prs" ? (
              snapshot ? (
                <PullRequests
                  prs={prs}
                  repository={project.repository}
                  reads={reads}
                  merging={merging}
                  canMerge={!closed}
                  ticketHref={(ticket) => roomHref(project.id, "prs", ticket)}
                  onOpen={opened}
                />
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

/** The Agents tab's first row: the project's coordinator, its chat in the lane. */
function CoordinatorRow({ href, current, onOpen }: { href: string; current: boolean; onOpen: () => void }) {
  return (
    <div
      data-coordinator
      data-current={current || undefined}
      className={cn(
        "relative grid grid-cols-[16px_minmax(0,1fr)] items-center gap-2.5 border-line border-b px-4 py-2",
        current ? "bg-panel-3" : "bg-card hover:bg-panel-3",
      )}
    >
      <MessagesSquare aria-hidden size={14} strokeWidth={1.75} className="text-text-3" />
      <a
        href={href}
        data-open
        aria-current={current ? "page" : undefined}
        onClick={onOpen}
        className="min-w-0 truncate text-sub text-text outline-none after:absolute after:inset-0 focus-visible:after:shadow-[inset_0_0_0_2px_var(--color-blue)]"
      >
        Coordinator
      </a>
    </div>
  );
}

const editable = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/**
 * The lane's keys (THE-2089): with the focus in the panel's Agents or in the
 * lane, `↑` `↓` (`K` `J`) show the previous or next agent, the Coordinator
 * (the chat) first, the ends holding; the focus follows to its row in the
 * panel, or stays in the lane. Escape returns to the chat, unless a field has
 * the focus, the output drawer took it, or the sheet is open (it closes first).
 * Keys replace the address: hopping adds nothing to Back.
 */
function useAgentKeys({
  project,
  agent,
  order,
  panel,
  lane,
  agents,
  sheet,
  open,
}: {
  project: string;
  agent: string | null;
  order: readonly string[];
  panel: RefObject<HTMLElement | null>;
  lane: RefObject<HTMLElement | null>;
  /** Whether the panel shows Agents. */
  agents: boolean;
  sheet: boolean;
  open: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = agentKey(e);
      if (!key || e.defaultPrevented || editable(e.target)) return;
      const target = e.target instanceof Node ? e.target : null;
      // The session's output drawer keeps its own keys: its arrows scroll, its Escape closes it.
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      if (key.kind === "chat") {
        if (agent === null || (sheet && open)) return;
        e.preventDefault();
        showAgent(project, null);
        return;
      }
      const inPanel = agents && open && !!panel.current?.contains(target);
      const inLane = !!lane.current?.contains(target);
      if (!inPanel && !inLane) return;
      e.preventDefault();
      const next = agentStep(order, agent, key.by);
      if (next === agent) return;
      if (inPanel) {
        // The focus moves to the next row, scrolled into the panel's view, the panel only.
        const row = panel.current?.querySelector<HTMLElement>(
          next === null ? "[data-coordinator]" : `[data-row="${CSS.escape(`${project}/${next}`)}"]`,
        );
        row?.querySelector<HTMLElement>("a[data-open]")?.focus({ preventScroll: true });
        const scroller = row?.closest<HTMLElement>('[role="tabpanel"]');
        if (row && scroller) {
          const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          const bottom = top + row.getBoundingClientRect().height - scroller.clientHeight;
          if (top < 0) scroller.scrollTop += top;
          else if (bottom > 0) scroller.scrollTop += bottom;
        }
      } else if (next !== null) lane.current?.focus({ preventScroll: true });
      showAgent(project, next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project, agent, order, panel, lane, agents, sheet, open]);
}

function Reading() {
  return <p className="m-0 px-4 py-3 text-body text-text-3">Reading the project's log.</p>;
}
