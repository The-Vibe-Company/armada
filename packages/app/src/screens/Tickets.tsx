// A project's tickets (THE-2124), `#/projects/<id>/tickets`, reached from its
// room's strip: the bar (its title, the project and each group's count, New
// ticket), then the list in the room's list style (FleetList's headings and
// rows): ready to launch, in flight (the session's phase and reason; a click
// opens the session's page), the backlog, then Done behind a disclosure,
// newest first. A ticket opens in the panel beside the list (`?ticket=`), the
// new ticket's form too (`?new`). The owner's writes are `ticket.create` and
// `ticket.update` (protocol minor 26), each with a request id kept until the
// daemon answers, so a retry is never a second ticket; Launch asks the
// coordinator, as the room's own "Launch what is ready" does. A project on
// Linear shows its tickets read-only, and one quiet line where New ticket is.
import { TICKETS_MINOR } from "@armada/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { DaemonProblem } from "@/components/DaemonProblem";
import { TONE } from "@/components/fleet/FleetList";
import { Page, PageBar, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { type FleetState, type FoldedTicket, fleetOf } from "@/fleet/state";
import { openExternal } from "@/lib/external";
import { type Translate, useT } from "@/lib/i18n";
import { roomHref, ticketsHref } from "@/lib/route";
import { cn } from "@/lib/utils";
import { useDaemon, useDaemonClient } from "@/protocol/store";
import { ticketPrefix } from "@/room/markdown-rules";
import { useSheet } from "@/room/panel-rules";
import { sessionHref } from "@/session/route";
import { Chips } from "@/tickets/Chips";
import { TicketDetail } from "@/tickets/TicketDetail";
import { TicketForm } from "@/tickets/TicketForm";
import { TicketPanel } from "@/tickets/TicketPanel";
import {
  createFields,
  draftOf,
  newId,
  READY_LABEL,
  requestWrites,
  TICKET_GROUPS,
  type TicketDraft,
  type TicketGroup,
  type TicketRow,
  ticketRows,
  updateFields,
} from "@/tickets/view";

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const EMPTY_STATE: FleetState = { sessions: [], tickets: [], pullRequests: [], inbox: [], queue: [], validations: [] };
const BLANK: TicketDraft = { title: "", description: "", labels: "", parent: "", ready: false };
const DOT: Record<TicketGroup, string> = {
  ready: "bg-green",
  flight: "bg-blue",
  backlog: "bg-text-3",
  done: "bg-merged",
};

/** One write sender per page, kept across renders. */
function useWrites() {
  const writes = useRef<ReturnType<typeof requestWrites> | null>(null);
  writes.current ??= requestWrites();
  return writes.current;
}

const go = (href: string) => {
  window.location.hash = href;
};

export function Tickets({
  project: id,
  ticket: selected,
  creating = false,
  onReload,
  now: givenNow,
  zone: givenZone,
}: {
  project: string;
  ticket?: string | undefined;
  creating?: boolean | undefined;
  onReload?: () => void;
  now?: number;
  zone?: string;
}) {
  const { projects, fleets, status, minor } = useDaemon();
  const client = useDaemonClient();
  const t = useT();
  const sheet = useSheet();
  const write = useWrites();
  // The ticket under edit, as the form opened on it: Save sends only what changed since.
  const [editing, setEditing] = useState<FoldedTicket | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // What one ticket's actions said belongs to it: another ticket starts quiet.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selection is what resets them.
  useEffect(() => {
    setProblem(null);
    setNotice(null);
    setEditing(null);
  }, [selected, creating]);

  const project = projects?.find((p) => p.id === id);
  const snapshot = project ? fleets[project.id] : undefined;
  const state = snapshot ? fleetOf(snapshot) : EMPTY_STATE;
  const rows = useMemo(() => ticketRows(state), [state]);
  const prefixes = useMemo(
    () =>
      [...new Set([...state.tickets.map((x) => x.id), ...state.sessions.map((s) => s.ticket)].map(ticketPrefix))]
        .sort()
        .join(" "),
    [state],
  );
  const now = givenNow ?? Date.now();
  const zone = givenZone ?? viewerZone();

  if (!project)
    return (
      <Page>
        <PageHeader
          facts={<span className="contents text-body">{t("tickets.title")}</span>}
          title={id}
          quiet={projects === null ? t("tickets.waiting") : t("tickets.none")}
        />
        {onReload && <DaemonProblem onReload={onReload} />}
      </Page>
    );

  const linear = (project.tracker ?? "linear") === "linear";
  // A daemon before minor 26 cannot be asked: its tickets are read-only here.
  const writable = !linear && (minor ?? 0) >= TICKETS_MINOR;
  const live = status === "live";
  const row = selected ? TICKET_GROUPS.flatMap((g) => rows[g]).find((r) => r.ticket.id === selected) : undefined;
  const close = () => go(ticketsHref(project.id));

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      setNotice(await action());
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const update = (ticket: string, fields: Record<string, unknown>) => {
    const body = { type: "ticket.update" as const, project: project.id, ticket, ...fields };
    return write(JSON.stringify(body), (requestId) => client.request({ ...body, requestId }));
  };
  const create = async (draft: TicketDraft) => {
    const body = { type: "ticket.create" as const, project: project.id, ...createFields(draft) };
    const created = await write(JSON.stringify(body), (requestId) => client.request({ ...body, requestId }));
    go(ticketsHref(project.id, { ticket: created.ticket }));
  };
  const save = async (draft: TicketDraft) => {
    if (!editing) return;
    const fields = updateFields(editing, draft);
    if (Object.keys(fields).length) await update(editing.id, fields);
    setEditing(null);
  };

  const rootUrl = project.root ? state.tickets.find((x) => x.id === project.root)?.url : undefined;
  const counts = TICKET_GROUPS.filter((g) => g !== "done").map((g) => (
    <span key={g} className="flex items-baseline gap-1.5" data-fact={g}>
      <b className="font-medium font-mono text-text tnum">{rows[g].length}</b>
      {t(`tickets.group.${g}`).toLocaleLowerCase()}
    </span>
  ));

  return (
    <div className="flex h-full min-h-0 flex-col" data-tickets={project.id}>
      <PageBar
        title={t("tickets.title")}
        facts={
          <>
            <a href={roomHref(project.id)} title={t("tickets.back")} className="text-text-2 hover:text-text">
              {project.name}
            </a>
            <span aria-hidden className="h-4 w-px flex-none bg-line" />
            {snapshot ? counts : <span>{t("tickets.reading")}</span>}
          </>
        }
        end={
          linear ? (
            <span data-linear-line className="text-body text-text-3">
              {t("tickets.linear")}
              {project.root && (
                <>
                  {" · "}
                  {rootUrl ? (
                    <a
                      href={rootUrl}
                      onClick={(e) => {
                        e.preventDefault();
                        openExternal(rootUrl);
                      }}
                      className="font-mono text-meta text-text-2 underline decoration-current/40 underline-offset-2 hover:text-text"
                    >
                      {project.root}
                    </a>
                  ) : (
                    <span className="font-mono text-meta text-text-2">{project.root}</span>
                  )}
                </>
              )}
            </span>
          ) : (
            writable && (
              <Button variant="soft" onClick={() => go(ticketsHref(project.id, "new"))} disabled={!live}>
                {t("tickets.new")}
              </Button>
            )
          )
        }
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-y-auto">
          {onReload && <DaemonProblem onReload={onReload} className="mx-4 mt-3" />}
          {snapshot && (
            <div className="flex min-w-0 flex-col pb-6">
              {(["ready", "flight", "backlog"] as const).map((group) => (
                <section key={group} className="flex min-w-0 flex-col" data-ticket-group={group}>
                  <GroupHeading group={group} n={rows[group].length} t={t} />
                  {rows[group].length === 0 ? (
                    <p className="m-0 px-4 pt-1.5 pb-2 text-body text-text-3">{t(`tickets.empty.${group}`)}</p>
                  ) : (
                    rows[group].map((r) => (
                      <Row key={r.ticket.id} row={r} project={project.id} current={r.ticket.id === selected} t={t} />
                    ))
                  )}
                </section>
              ))}
              {rows.done.length > 0 && (
                <details className="group/done flex min-w-0 flex-col" data-ticket-group="done">
                  <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                    <GroupHeading group="done" n={rows.done.length} t={t} disclosure />
                  </summary>
                  {rows.done.map((r) => (
                    <Row key={r.ticket.id} row={r} project={project.id} current={r.ticket.id === selected} t={t} />
                  ))}
                </details>
              )}
            </div>
          )}
        </div>
        <TicketPanel
          open={creating || selected !== undefined}
          sheet={sheet}
          heading={creating ? t("tickets.new") : selected}
          label={t("tickets.panel")}
          closeLabel={t("tickets.close")}
          onClose={close}
        >
          {creating ? (
            writable ? (
              <TicketForm key="new" initial={BLANK} creating t={t} onSubmit={create} onDiscard={close} />
            ) : (
              <p className="m-0 px-4 py-4 text-body text-text-3">{t("tickets.linear")}</p>
            )
          ) : row && editing?.id === row.ticket.id ? (
            <TicketForm
              key={`edit:${row.ticket.id}`}
              initial={draftOf(editing)}
              creating={false}
              t={t}
              onSubmit={save}
              onDiscard={() => setEditing(null)}
            />
          ) : row ? (
            <TicketDetail
              project={project.id}
              repository={project.repository}
              prefixes={prefixes}
              ticket={row.ticket}
              group={row.group}
              writable={writable}
              busy={busy || !live}
              problem={problem}
              notice={notice}
              now={now}
              zone={zone}
              t={t}
              actions={{
                ready: (ready) =>
                  run(async () => {
                    await update(row.ticket.id, ready ? { addLabels: [READY_LABEL] } : { removeLabels: [READY_LABEL] });
                    return null;
                  }),
                edit: () => setEditing(row.ticket),
                cancel: () =>
                  run(async () => {
                    await update(row.ticket.id, { state: "canceled" });
                    return null;
                  }),
                launch: () =>
                  run(async () => {
                    // The coordinator's own words: the message is English, whatever the page's language.
                    await client.request({
                      type: "chat.send",
                      project: project.id,
                      requestId: newId(),
                      body: `Launch ${row.ticket.id}`,
                    });
                    return t("tickets.launchAsked");
                  }),
              }}
            />
          ) : (
            selected && <p className="m-0 px-4 py-4 text-body text-text-3">{t("tickets.missing", { id: selected })}</p>
          )}
        </TicketPanel>
      </div>
    </div>
  );
}

/** A group's heading, as the room's list draws its: its dot, its name, its count. */
function GroupHeading({
  group,
  n,
  t,
  disclosure = false,
}: {
  group: TicketGroup;
  n: number;
  t: Translate;
  disclosure?: boolean;
}) {
  return (
    <h2 className="m-0 flex items-center gap-2 px-4 pt-3 pb-1 font-normal text-body text-text-3">
      <span aria-hidden className={cn("size-2 rounded-full", DOT[group])} />
      {t(`tickets.group.${group}`)}
      <span className="font-medium font-mono text-meta text-text-2 tnum">{n}</span>
      {disclosure && (
        <span aria-hidden className="text-text-3 transition-transform group-open/done:rotate-90">
          ›
        </span>
      )}
    </h2>
  );
}

/** One ticket: its id, title, labels and parent; in flight, its session's phase and reason under them. */
function Row({ row, project, current, t }: { row: TicketRow; project: string; current: boolean; t: Translate }) {
  const { ticket, session, tone } = row;
  const done = row.group === "done";
  const href = row.group === "flight" ? sessionHref(ticket.id) : ticketsHref(project, { ticket: ticket.id });
  return (
    <div
      data-ticket-row={ticket.id}
      data-current={current || undefined}
      className={cn(
        "relative grid grid-cols-[minmax(0,1fr)] gap-0.5 border-line border-b px-4 py-2",
        current ? "bg-panel-3" : "bg-card hover:bg-panel-3",
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <a
          href={href}
          aria-current={current ? "page" : undefined}
          className="min-w-0 truncate outline-none after:absolute after:inset-0 focus-visible:after:shadow-[inset_0_0_0_2px_var(--color-blue)]"
        >
          <span className="mr-2 font-mono text-meta text-text-2">{ticket.id}</span>
          <span className={done ? "text-body text-text-2" : "text-sub text-text"}>{ticket.title ?? ""}</span>
        </a>
        {ticket.parent && (
          <span className="ml-auto flex-none font-mono text-meta text-text-3" data-parent>
            {t("tickets.parent", { id: ticket.parent })}
          </span>
        )}
      </span>
      {(ticket.labels?.length ?? 0) > 0 && <Chips labels={ticket.labels ?? []} />}
      {session && (
        <span className={cn("truncate text-body", tone ? TONE[tone].text : "text-text-3")} data-session>
          <span className="text-text-2">{session.phase}</span>
          {session.reason ? ` · ${session.reason}` : ""}
        </span>
      )}
    </div>
  );
}
