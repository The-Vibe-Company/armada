// A ticket in the Tickets page's panel (THE-2124): its title, state, labels,
// parent and blockers, its description as Markdown, its comments oldest
// first, then what the owner can do: Mark ready or Not ready, Edit, Cancel and
// Launch. A project whose tracker is Linear shows it read-only, Launch aside
// (a request to the coordinator, not a tracker write).
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { rowTime } from "@/fleet/overview";
import type { FoldedTicket } from "@/fleet/state";
import type { StringKey, Translate } from "@/lib/i18n";
import { ticketsHref } from "@/lib/route";
import { Markdown } from "@/room/Markdown";
import { Chips } from "./Chips";
import { isReady, type TicketGroup } from "./view";

export interface TicketActions {
  ready: (ready: boolean) => void;
  edit: () => void;
  cancel: () => void;
  launch: () => void;
}

export function TicketDetail({
  project,
  repository,
  prefixes,
  ticket,
  group,
  writable,
  busy,
  problem,
  notice,
  actions,
  now,
  zone,
  t,
}: {
  project: string;
  repository: string;
  prefixes: string;
  ticket: FoldedTicket;
  group: TicketGroup;
  /** The tracker takes the owner's edits (internal tickets); else read-only. */
  writable: boolean;
  /** An action is on its way to the daemon. */
  busy: boolean;
  /** The daemon's refusal of the last action, in red. */
  problem: string | null;
  /** What the last action did, quietly. */
  notice: string | null;
  actions: TicketActions;
  now: number;
  zone: string;
  t: Translate;
}) {
  const ready = isReady(ticket);
  const open = group !== "done" && group !== "flight";
  const comments = [...(ticket.comments ?? [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const link = (id: string) => (
    <a
      key={id}
      href={ticketsHref(project, { ticket: id })}
      className="font-mono text-meta text-text-2 underline decoration-current/40 underline-offset-2 hover:text-text"
    >
      {id}
    </a>
  );
  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4" data-ticket-detail={ticket.id}>
      <h2 className="m-0 text-pretty font-medium text-sub text-text">{ticket.title ?? ticket.id}</h2>
      <dl className="m-0 grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-body">
        <Fact term={t("tickets.state")}>
          <span data-ticket-state>{ticket.status ? t(`tickets.status.${ticket.status}` as StringKey) : "—"}</span>
        </Fact>
        {(ticket.labels?.length ?? 0) > 0 && (
          <Fact term={t("tickets.labels")}>
            <Chips labels={ticket.labels ?? []} />
          </Fact>
        )}
        {ticket.parent && <Fact term={t("tickets.parentField")}>{link(ticket.parent)}</Fact>}
        {(ticket.blockers?.length ?? 0) > 0 && (
          <Fact term={t("tickets.blockers")}>
            <span className="flex flex-wrap gap-x-2">{ticket.blockers?.map((b) => link(b.id))}</span>
          </Fact>
        )}
      </dl>
      {ticket.description?.trim() ? (
        <Markdown text={ticket.description} repository={repository} prefixes={prefixes} breaks />
      ) : (
        <p className="m-0 text-body text-text-3">{t("tickets.noDescription")}</p>
      )}
      {comments.length > 0 && (
        <section className="flex min-w-0 flex-col gap-3" aria-label={t("tickets.comments")}>
          <h3 className="m-0 font-medium text-heading text-text-3">{t("tickets.comments")}</h3>
          {comments.map((c) => (
            <article key={`${c.at}/${c.body.slice(0, 32)}`} className="flex min-w-0 flex-col gap-1" data-comment>
              <span className="text-meta text-text-3">
                {c.author ? `${c.author} · ` : ""}
                <span className="font-mono tnum">{rowTime(c.at, now, zone)}</span>
              </span>
              <Markdown text={c.body} repository={repository} prefixes={prefixes} breaks />
            </article>
          ))}
        </section>
      )}
      {(open || writable) && (
        <div className="flex flex-wrap items-center gap-2 border-line border-t pt-3">
          {writable && open && (
            <Button variant={ready ? "soft" : "primary"} disabled={busy} onClick={() => actions.ready(!ready)}>
              {ready ? t("tickets.notReady") : t("tickets.markReady")}
            </Button>
          )}
          {writable && (
            <Button variant="soft" disabled={busy} onClick={actions.edit}>
              {t("tickets.edit")}
            </Button>
          )}
          {writable && ticket.status !== "canceled" && ticket.status !== "completed" && (
            <Button variant="ghost" disabled={busy} onClick={actions.cancel}>
              {t("tickets.cancel")}
            </Button>
          )}
          {group === "ready" && (
            <Button variant="soft" disabled={busy} onClick={actions.launch} className="ml-auto">
              {t("tickets.launch")}
            </Button>
          )}
        </div>
      )}
      {problem && (
        <p role="alert" data-ticket-problem className="m-0 text-body text-red">
          {problem}
        </p>
      )}
      {notice && !problem && (
        <p role="status" className="m-0 text-body text-text-3">
          {notice}
        </p>
      )}
    </div>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-text-3">{term}</dt>
      <dd className="m-0 min-w-0 text-text-2">{children}</dd>
    </>
  );
}
