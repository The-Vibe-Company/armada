// A session's page (`#/sessions/<ticket>`), a placeholder until the local
// runtime brings its transcript, diff and terminal (docs/v2-desktop.md step 3).
// It names the ticket and leads back to its project's room.
import { Dot, Page, PageHeader } from "@/components/page";
import { fleetOf } from "@/fleet/state";
import { roomHref } from "@/lib/route";
import { useDaemon } from "@/protocol/store";

export function SessionPlaceholder({ ticket }: { ticket: string }) {
  const { projects, fleets } = useDaemon();
  const found = (projects ?? []).flatMap((p) => {
    const snapshot = fleets[p.id];
    const session = snapshot ? fleetOf(snapshot).sessions.find((s) => s.ticket === ticket) : undefined;
    return session ? [{ project: p, title: session.title }] : [];
  })[0];
  return (
    <Page>
      <PageHeader
        facts={
          <span className="contents text-body">
            <span>Session</span>
            {found && (
              <>
                <Dot />
                <a href={roomHref(found.project.id)} className="text-text-2 hover:text-text">
                  {found.project.name}
                </a>
              </>
            )}
          </span>
        }
        title={found ? `${ticket} · ${found.title}` : ticket}
        quiet="The session's page comes with the local runtime: its transcript, its diff and its terminal."
      />
    </Page>
  );
}
