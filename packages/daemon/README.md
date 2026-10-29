# Armada daemon store

`@armada/daemon` is the V2 daemon's private workspace package. It runs on Node
22.18+ (native TypeScript support), uses `node:sqlite`, and has no V1 imports.
The root `packages/*` workspace glob includes it.

```ts
import { EventStore } from "@armada/daemon/store";
import { fold } from "@armada/daemon/fold";

const store = new EventStore("/path/to/fleet.sqlite");
const event = store.append({
  project: "orchard",
  kind: "hold.opened",
  at: "2030-01-01T10:00:00Z",
  actor: "Mira",
  payload: { id: "release-check", reason: "Wait for deployment" },
});
const fleet = fold(store.readSince(0));
const later = store.readSince(event.seq, "orchard");
store.close();
```

The caller supplies the project, timestamp and actor. SQLite assigns a global,
monotonically increasing `seq`; replay uses `seq > cursor`, ordered by sequence,
even when timestamps repeat or arrive out of order. A project filter keeps the
global sequence, so gaps are expected. WAL and full synchronous commits preserve
the log across process restarts. Updates, deletes and replacing existing rows
are refused by triggers. Close the store before copying the database and its WAL
for a backup; live SQLite backups require SQLite's backup API.

`fold` takes a complete log, or a complete project-filtered log from sequence 0.
It does not accept incremental batches as a replacement for prior history.
It returns the last sequence and tables keyed by project: ticket and PR
observations, the latest generation of each ticket's session (including merged
and released sessions), those sessions grouped by state, the open inbox, the
active FIFO merge queue, open holds, and all validations with their first
recorded decision. A decided validation stops waiting for the owner even before
the worker reports its next phase. Answers, queue refusals/cancellations/confirmed merges, and
hold clears remove the corresponding active row; history stays in the log.
Conversation and checkpoint events are stored without changing fleet rows.

Claim session IDs identify a generation and must be unique within a project.
Each claim also carries a positive integer `generation`, assigned monotonically
per ticket by the launcher. Only a higher generation can replace the current
session, including when an older claim arrives late for the first time. Tracker
sessions use generation 0. Timestamps never decide generation order.
Reports, heartbeats, releases and merge confirmations name that generation;
stale generations cannot change the current session. Request/queue/hold/validation
IDs identify one operation and should not be reused. A tracker observation may
create a synthetic `tracker:<ticket>` session before a local claim exists;
a local claim takes precedence over later tracker phase observations. PR reads
enrich CI and conflict state; `merge.confirmed` records a local merge outcome.
The copied phase/flow rules name their core source in `src/rules.ts`.

The event vocabulary is temporarily in `src/events.ts` while THE-1985 builds
`packages/protocol`. Follow-up adapters should use these contracts until that
package carries the shared kinds. Nothing in the app should import the daemon.

Run `bun run test:daemon` from the repository root for Node's test runner. The
same tests run in the Bun suite; `bun run verify` and CI also exercise native
Node SQLite explicitly. Store tests use disposable database files; fold tests
use invented tickets and people without I/O.
