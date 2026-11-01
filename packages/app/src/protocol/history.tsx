import { type ProtocolEvent, REPLAY_MINOR } from "@armada/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DaemonClient } from "./client";
import { useDaemon } from "./store";

/** Keep historical reads local to their pane; they never advance the live subscription cursor. */
export function useHistory(client: DaemonClient | undefined, project?: string, ticket?: string) {
  const { status, minor } = useDaemon();
  const key = JSON.stringify([project, ticket]);
  const [page, setPage] = useState({
    key,
    events: [] as ProtocolEvent[],
    cursor: null as number | null,
    loading: false,
    error: "",
  });
  const generation = useRef(0);
  const busy = useRef(false);
  const read = useCallback(
    async (cursor?: number) => {
      if (!client || !project || busy.current) return;
      const current = generation.current;
      busy.current = true;
      setPage((held) => ({ ...held, loading: true, error: "" }));
      try {
        const reply = await client.request({
          type: "fleet.history",
          project,
          ...(ticket ? { ticket } : {}),
          ...(cursor === undefined ? {} : { cursor }),
          limit: 50,
        });
        if (current !== generation.current) return;
        setPage((held) => ({
          key,
          events: mergeHistory(cursor === undefined ? [] : held.events, reply.events),
          cursor: reply.cursor,
          loading: false,
          error: "",
        }));
      } catch (error) {
        if (current === generation.current)
          setPage((held) => ({
            ...held,
            loading: false,
            error: error instanceof Error ? error.message : "Could not read history",
          }));
      } finally {
        if (current === generation.current) busy.current = false;
      }
    },
    [client, project, ticket, key],
  );
  useEffect(() => {
    generation.current++;
    busy.current = false;
    setPage({ key, events: [], cursor: null, loading: false, error: "" });
    if (client && project && status === "live" && (minor ?? 0) >= REPLAY_MINOR) void read();
    return () => {
      generation.current++;
      busy.current = false;
    };
  }, [client, project, key, status, minor, read]);
  const held = page.key === key ? page : { events: [], cursor: null, loading: false, error: "" };
  return {
    ...held,
    loadEarlier: () => {
      if (held.cursor !== null) void read(held.cursor);
    },
    retry: () => {
      void read(held.cursor ?? undefined);
    },
  };
}

/** Existing live rows and explicit historical pages share immutable sequence identities. */
export function mergeHistory(live: readonly ProtocolEvent[], history: readonly ProtocolEvent[]): ProtocolEvent[] {
  return [...new Map([...live, ...history].map((event) => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);
}

export function HistoryControls({ history }: { history: ReturnType<typeof useHistory> }) {
  if (!history.loading && !history.error && history.cursor === null) return null;
  return (
    <div className="flex flex-col items-start gap-2 px-1 py-2 text-body text-text-3">
      {history.loading && (
        <p role="status" className="m-0">
          Loading history…
        </p>
      )}
      {history.error && (
        <>
          <p role="alert" className="m-0 text-red">
            {history.error}
          </p>
          <Button variant="soft" onClick={history.retry}>
            Try again
          </Button>
        </>
      )}
      {history.cursor !== null && !history.error && (
        <Button variant="soft" disabled={history.loading} onClick={history.loadEarlier}>
          Load earlier
        </Button>
      )}
    </div>
  );
}
