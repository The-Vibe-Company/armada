# Tracker reads

`linearTracker` implements `Tracker` without importing V1, the store, the fold,
HTTP handlers or runtime code. `linear/` is self-contained apart from the
Tracker type boundary and the single `readLinearKey` secrets accessor. It can
move into the Linear plugin when the boot-time plugin loader lands. The default
`readLinearKey` uses the host's shared `Keychain.read` gateway (macOS OS Keychain;
explicit private Linux/CI app-config fallback). The Linear account is the project
id under service `armada.linear`. There is no environment or V1 credential-file
fallback. Embedders/tests can still supply a `SecretAccessor`; bind a `Keychain`
instance with `keychain.read.bind(keychain)`.

At daemon boot, create one reader and poller per configured project:

```ts
import { linearTracker, TrackerPoller } from "./index.ts";

const tracker = linearTracker({
  project: project.id,
  rootId: project.linearRoot, // human identifier, e.g. SEED-1
  phaseGroup: project.phaseGroup,
  fetch,
  now: () => new Date(),
});
const poller = new TrackerPoller({
  project: project.id,
  tracker,
  store, // append/readSince; server subscribers observe the same committed events
  clock: {
    now: () => new Date(),
    set(callback, delay) {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  },
});
poller.start(); // returns immediately; never await a read in a protocol handler
// On daemon shutdown:
poller.stop();
```

`poller.status` is a detached, secret-free reading for the owner's timer: the
interval, whether a read is running, last start/completion, next scheduled read,
and a fixed failure/timeout message. Defaults: read every 30 seconds after the
last attempt settles, a 30-second deadline per reading, a full read every 30
minutes. The host may override all three. Failures retry on the next tick with
the last successful cursor. Stopping aborts the current read and clears the
next tick; late results cannot append. Providers must yield to asynchronous I/O
and honor the supplied signal; the deadline also handles promises that ignore
cancellation. A timed-out provider retains the single-read gate until its
promise settles; scheduled ticks and manual refreshes cannot accumulate hanging
requests. The owner still sees the timeout and pending-read state. This is not isolation from a plugin's synchronous infinite loop.

The first read walks the program tree and every ticket's comments. Later reads
query changed tickets/comments after the previous **start**, overlapping one
second, and walk any newly discovered subtree. Connections are paginated;
non-advancing/missing cursors or limits fail the whole read, preserving the
previous watermark. Periodic full reads catch deletions and removals. Nothing
fetches on a page load, subscription or other protocol request.

Only changes append: `ticket.seen` drives the existing tracker sessions in the
fold; `ticket.phase-changed` and `ticket.report-posted` keep source history;
questions use `inbox.opened`, and an answer/resumption retires the open item.
Coordinator notes do not count as worker reports or resolve questions. Comment
edits create a new report revision/question identity. A completed ticket maps
to merged and a canceled/out-of-scope ticket to released; local claims retain
their generation and take precedence over tracker observations in the fold.
A cold restart performs a full read and deduplicates against the log. Raw
comments remain in the reader's in-memory snapshot; only worker reports are
persisted as history. Ticket labels/attachments/parents are available through
TrackerReading for future tracker tools.

The composition above is for the boot owner; this module does not change the
parallel WebSocket server or configure projects/secrets for it. No token or
server error body is included in diagnostics.

The focused recorded-fetch and scheduling tests run in the normal daemon suite.
The cross-ticket transport proof is deliberately opt-in until THE-1987 lands:
`node --test packages/daemon/test/tracker-websocket.integration.ts` from the
repository root. It uses the real server and store, a loopback port chosen by
the OS, and a hanging recorded Linear fetch. It subscribes, replays, and receives
a live commit while the read remains pending. Before the server lands, set
`ARMADA_TEST_DAEMON_ROOT` to an isolated copy of that PR's `src/` (with its
runtime dependencies resolvable). No server source is copied into this PR.
