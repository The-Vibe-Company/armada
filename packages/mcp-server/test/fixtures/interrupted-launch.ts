import { launchSandbox } from "@armada/core/server";
import { createSqlData } from "../../src/data.ts";
import { fakeBoat } from "../support.ts";

// The SQL server lives in the parent process, just as Postgres survives an API crash.
const endpoint = process.argv[2]!;
const actor = JSON.parse(process.argv[3]!);
const sql = {
  async query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({ text, values }) });
    if (!response.ok) throw Error("SQL fixture failed");
    return response.json();
  },
};
const data = createSqlData(sql)({
  via: "service",
  userId: actor.userId,
  orgs: [{ orgId: actor.orgId, role: actor.role }],
});
await launchSandbox(
  fakeBoat().provider,
  {
    goldens: data.goldens,
    sandboxes: data.sandboxes,
    credentials: { resolve: async () => ({ env: {}, secrets: [], codexAuthJson: false }) },
  },
  actor,
  { golden: "shared", harness: "claude" },
  {
    onRegistered: async () => {
      // No catch/finally or heartbeat can run after SIGKILL.
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    },
  },
);
