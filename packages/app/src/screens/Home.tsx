import { APP_TOO_OLD, DAEMON_TOO_OLD } from "@armada/protocol";
import { Block, Dot, Page, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { sessionsInFlight } from "@/fleet/sessions";
import { LOG_BEHIND } from "@/protocol/client";
import { useDaemon } from "@/protocol/store";

/** The home page, in the v7 anatomy; app/fleet fills its blocks with the fleet by state. */
export function Home({ address, onReload }: { address: string; onReload: () => void }) {
  const { projects, logs, problem, status } = useDaemon();
  const sessions = (projects ?? []).reduce((n, p) => n + sessionsInFlight(logs[p.id]?.events ?? []), 0);
  // Counted once every project's first frame arrived, so the line never says 0 before it knows.
  const read = projects?.every((p) => logs[p.id]) ?? false;
  // Reloading helps after an update, or when the daemon's log went back; not with an address it cannot open.
  const reload = problem === LOG_BEHIND || problem === APP_TOO_OLD || problem === DAEMON_TOO_OLD;
  return (
    <Page>
      <PageHeader
        facts={
          <>
            <span>Daemon</span>
            <Dot />
            <span className="font-mono">{address}</span>
          </>
        }
        title="Fleet"
        quiet={
          projects === null
            ? "Waiting for the daemon to list its projects."
            : read
              ? `${plural(projects.length, "project")} · ${plural(sessions, "session")} in flight`
              : `${plural(projects.length, "project")} · reading their logs`
        }
      />
      {problem && (
        <div
          role="alert"
          className={`flex items-center gap-3 rounded-card bg-card px-4 py-3 shadow-ring ${status === "refused" ? "text-red" : "text-amber"}`}
        >
          <span className="flex-1">{problem}</span>
          {reload && (
            <Button variant="soft" onClick={onReload}>
              Reload
            </Button>
          )}
        </div>
      )}
      {projects && projects.length > 0 && (
        <Block heading="Projects">
          <ul className="m-0 flex list-none flex-col p-0">
            {projects.map((p) => (
              <li key={p.id} className="flex h-row items-center gap-3 border-line-soft border-b">
                <span className="min-w-0 flex-1 truncate text-text">{p.name}</span>
                <span className="font-mono text-meta text-text-3">{p.repository}</span>
                <span className="w-24 text-right text-text-2 tnum">
                  {logs[p.id] && plural(sessionsInFlight(logs[p.id]?.events ?? []), "session")}
                </span>
              </li>
            ))}
          </ul>
        </Block>
      )}
    </Page>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
