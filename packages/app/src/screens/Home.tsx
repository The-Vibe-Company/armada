import { Block, Dot, Page, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { sessionsInFlight } from "@/fleet/sessions";
import { useDaemon } from "@/protocol/store";

/** The home page, in the v7 anatomy; app/fleet fills its blocks with the fleet by state. */
export function Home({ address, onReload }: { address: string; onReload: () => void }) {
  const { projects, logs, problem, status } = useDaemon();
  const sessions = (projects ?? []).reduce((n, p) => n + sessionsInFlight(logs[p.id]?.events ?? []), 0);
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
            : `${plural(projects.length, "project")} · ${plural(sessions, "session")} in flight`
        }
      />
      {problem && (
        <div
          role="alert"
          className={`flex items-center gap-3 rounded-card bg-card px-4 py-3 shadow-ring ${status === "refused" ? "text-red" : "text-amber"}`}
        >
          <span className="flex-1">{problem}</span>
          {status === "refused" && (
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
                  {plural(sessionsInFlight(logs[p.id]?.events ?? []), "session")}
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
