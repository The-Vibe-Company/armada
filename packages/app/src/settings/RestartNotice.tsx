import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useDaemon, useDaemonClient } from "@/protocol/store";

/**
 * What waits for the daemon's restart (THE-2069): a switch or a setting saved
 * since it started applies when it restarts. Shown above Providers and About
 * › Advanced when something changed, with Restart when the desktop shell can
 * restart it. `pending` counts the changes the page knows of.
 */
export function Restart({ pending }: { pending: number }) {
  const { plugins, status, restarting } = useDaemon();
  if (!restarting && pending === 0) return null;
  return (
    <RestartNotice
      pending={pending}
      restartable={plugins?.restartable ?? false}
      restarting={restarting}
      live={status === "live"}
    />
  );
}

function RestartNotice({
  pending,
  restartable,
  restarting,
  live,
}: {
  pending: number;
  restartable: boolean;
  restarting: boolean;
  live: boolean;
}) {
  const client = useDaemonClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  async function restart() {
    setAsking(true);
    setProblem(null);
    try {
      await client.restartDaemon();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The daemon could not restart.");
    } finally {
      setAsking(false);
    }
  }
  return (
    <div
      role="status"
      data-restart-notice
      className="flex flex-wrap items-center gap-3 rounded-card bg-card px-4 py-3 shadow-ring"
    >
      <span aria-hidden className="size-2 flex-none rounded-full bg-amber" />
      <span className="min-w-0 flex-1">
        {restarting ? (
          <span className="text-amber">Restarting the daemon. The list comes back when it does.</span>
        ) : (
          <>
            <span className="text-amber">Restart to apply.</span>{" "}
            <span className="text-text-2">
              {pending === 1 ? "One setting changed" : `${pending} settings changed`} since the daemon started.
              {!restartable && " Quit and reopen Armada to apply them."}
            </span>
          </>
        )}
        {problem && (
          <span role="alert" className="block text-red">
            {problem}
          </span>
        )}
      </span>
      {restartable && !restarting && (
        <Button variant="soft" onClick={restart} disabled={asking || !live}>
          Restart
        </Button>
      )}
    </div>
  );
}
