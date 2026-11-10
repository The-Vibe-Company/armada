import { MOCK } from "./helpers";

/**
 * A busy organization's last thirty hours, as production showed it when #801 was written: 175 stopped sandboxes, a
 * few live agents, five "box moved" interruptions that were resent or relaunched, a night's harness crashes long
 * superseded, an interrupted launch already reconciled, and the handful of rows that do need the operator.
 */

const HOUR = 3600_000;
const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
const uuid = (group: number, n: number) => `00000000-0000-4000-8${group}00-${String(n).padStart(12, "0")}`;
export const SHA = "4f1c2a9e0b7d3c6f5a8e1d2c3b4a59687f6e5d4c";
export const BOX_MOVED = "The box moved to a new machine while this prompt was running. Send it again.";

type Event = Record<string, unknown>;
type Row = Record<string, unknown> & { id: string; events?: Event[] };

const prompt = (id: string, at: number, text: string, status: string, extra: Event = {}): Event => ({
  id,
  at,
  kind: "prompt",
  text,
  status,
  promptId: id,
  conversationId: "c1",
  ...extra,
});
const message = (id: string, at: number, text: string, promptId: string, tools: Event[] = []): Event => ({
  id,
  at,
  kind: "message",
  text,
  partial: false,
  tools,
  promptId,
  conversationId: "c1",
});
const work = (issue: number) => `Deliver issue #${issue} in acme/web: read the issue, implement it, open a PR.`;

/** The sandboxes that hold something for the operator, by the role they play in the tests. */
export const BUSY = {
  working: uuid(1, 1),
  expiring: uuid(1, 2),
  ready: uuid(1, 3),
  readyStopped: uuid(1, 4),
  blocked: uuid(1, 5),
  unconcluded: uuid(1, 6),
  interrupted: uuid(1, 7),
  failed: uuid(1, 8),
  /** A box-moved interruption whose issue was relaunched: the relaunch (`ready`) replaces it. */
  supersededMove: uuid(2, 1),
  /** A harness crash of the night before, relaunched since. */
  supersededCrash: uuid(2, 6),
};

export const BUSY_LABELS = {
  working: "bx_parser_812",
  expiring: "bx_search_809",
  ready: "bx_fleet_801",
  blocked: "bx_billing_806",
  unconcluded: "bx_cache_810",
  interrupted: "bx_docs_811",
  failed: "bx_api_814",
};

export function busyFleet(): Row[] {
  const now = Date.now();
  const live = { status: "ready", repository_dir: "web", expires_at: ahead(5 * HOUR) };
  const rows: Row[] = [
    {
      ...live,
      id: BUSY.working,
      provider_sandbox_id: BUSY_LABELS.working,
      status: "running",
      created_at: ago(50 * MIN),
      events: [
        prompt("w1", now - 42 * MIN, work(812), "running"),
        message("w2", now - 2 * MIN, "Running the parser suite.", "w1", [
          { id: "t1", name: "Bash", input: { command: "bun test test/parser.test.ts" } },
        ]),
      ],
    },
    {
      ...live,
      id: BUSY.expiring,
      provider_sandbox_id: BUSY_LABELS.expiring,
      status: "running",
      created_at: ago(5 * HOUR),
      expires_at: ahead(18 * MIN),
      events: [
        prompt("e1", now - 3 * HOUR, work(809), "running"),
        message("e2", now - 5 * MIN, "Rebuilding the search index.", "e1"),
      ],
    },
    {
      ...live,
      id: BUSY.ready,
      provider_sandbox_id: BUSY_LABELS.ready,
      created_at: ago(2 * HOUR),
      task_prompt_id: "r1",
      task_outcome: { state: "ready", prNumber: 805, prUrl: "https://github.com/acme/web/pull/805", headSha: SHA },
      events: [
        prompt("r1", now - 2 * HOUR, work(801), "finished"),
        message(
          "r2",
          now - 20 * MIN,
          "PR #805 is open, CI is green, the board only shows what needs a decision.",
          "r1",
        ),
      ],
    },
    {
      id: BUSY.readyStopped,
      provider_sandbox_id: "bx_tokens_799",
      status: "stopped",
      repository_dir: "web",
      created_at: ago(9 * HOUR),
      stopped_at: ago(6 * HOUR),
      task_prompt_id: "s1",
      task_outcome: { state: "ready", prNumber: 803, prUrl: "https://github.com/acme/web/pull/803" },
      preservation_note: `unpushed work preserved at work_recovery:${uuid(1, 4)}/${uuid(9, 1)}`,
      events: [
        prompt("s1", now - 9 * HOUR, work(799), "finished"),
        message("s2", now - 6 * HOUR, "Token rotation is in PR #803.", "s1"),
      ],
    },
    {
      id: BUSY.blocked,
      provider_sandbox_id: BUSY_LABELS.blocked,
      status: "stopped",
      repository_dir: "web",
      created_at: ago(4 * HOUR),
      stopped_at: ago(3 * HOUR),
      task_prompt_id: "b1",
      task_outcome: { state: "blocked", reason: "The staging Stripe key is missing; add it to the org credentials?" },
      events: [
        prompt("b1", now - 4 * HOUR, work(806), "finished"),
        message("b2", now - 3 * HOUR, "I need the staging Stripe key to run the billing tests.", "b1"),
      ],
    },
    {
      ...live,
      id: BUSY.unconcluded,
      provider_sandbox_id: BUSY_LABELS.unconcluded,
      created_at: ago(3 * HOUR),
      events: [
        prompt("u1", now - 3 * HOUR, work(810), "finished"),
        message("u2", now - 40 * MIN, "I moved the cache behind a feature flag. Next I would wire the metrics.", "u1"),
      ],
    },
    {
      ...live,
      id: BUSY.interrupted,
      provider_sandbox_id: BUSY_LABELS.interrupted,
      created_at: ago(90 * MIN),
      events: [
        prompt("i1", now - 80 * MIN, work(811), "failed", { reason: BOX_MOVED }),
        message("i2", now - 70 * MIN, "Reading the docs index.", "i1"),
      ],
    },
    {
      id: BUSY.failed,
      provider_sandbox_id: BUSY_LABELS.failed,
      status: "failed",
      repository_dir: "web",
      created_at: ago(30 * MIN),
      last_observed_at: ago(10 * MIN),
      status_reason: "usage_limit",
      events: [prompt("f1", now - 30 * MIN, work(814), "failed", { reason: "usage_limit" })],
    },
  ];

  // Five "box moved" interruptions. Two were relaunched on the same issue (the newer sandbox replaces them), three
  // were resent on the same sandbox and finished, then stopped: none is a failure.
  const moved = (n: number, issue: number, resent: boolean): Row => ({
    id: uuid(2, n),
    provider_sandbox_id: `bx_moved_${n}`,
    status: "stopped",
    repository_dir: "web",
    created_at: ago(20 * HOUR + n * MIN),
    stopped_at: ago(10 * HOUR),
    preservation_note: `unpushed work preserved at work_recovery:${uuid(2, n)}/${uuid(9, n)}`,
    events: [
      prompt(`m${n}a`, now - 20 * HOUR, work(issue), "failed", { reason: BOX_MOVED }),
      ...(resent
        ? [
            prompt(`m${n}b`, now - 19 * HOUR, work(issue), "finished"),
            message(`m${n}c`, now - 18 * HOUR, "Done; the work continued after the move.", `m${n}b`),
          ]
        : []),
    ],
  });
  rows.push(moved(1, 801, false), moved(2, 806, false), moved(3, 790, true), moved(4, 791, true), moved(5, 792, true));

  // The night's harness crashes, each relaunched on the same issue since. The lifecycle worker records the stop of a
  // failed machine itself, so a crash carries a stop time whether or not anyone looked at it.
  const crash = (n: number, issue: number): Row => ({
    id: uuid(2, n),
    provider_sandbox_id: `bx_crash_${n}`,
    status: "failed",
    repository_dir: "web",
    created_at: ago(26 * HOUR + n * MIN),
    last_observed_at: ago(23 * HOUR),
    stopped_at: ago(25 * HOUR),
    status_reason: "The harness exited unexpectedly (code 137).",
    events: [prompt(`c${n}`, now - 26 * HOUR, work(issue), "failed", { reason: "harness_crashed" })],
  });
  rows.push(crash(6, 812), crash(7, 809), crash(8, 810), crash(9, 811), crash(10, 799));
  // The launch interrupted by a deploy, already reconciled and stopped (the server's closed diagnostic).
  rows.push({
    id: uuid(2, 11),
    provider_sandbox_id: "bx_launch_interrupted",
    status: "failed",
    created_at: ago(15 * HOUR),
    stopped_at: ago(15 * HOUR - 5 * MIN),
    status_reason: "Launch interrupted before completion; provider cleanup is retried until confirmed.",
  });
  // 175 stopped sandboxes: finished work, nothing left for the operator.
  for (let n = 1; n <= 175; n++)
    rows.push({
      id: uuid(3, n),
      provider_sandbox_id: `bx_done_${n}`,
      status: "stopped",
      created_at: ago(30 * HOUR - n * 9 * MIN),
      stopped_at: ago(29 * HOUR - n * 9 * MIN),
    });
  return rows;
}

/** Puts the busy organization into the mock, next to its own three sandboxes. */
export async function seedBusyFleet(): Promise<void> {
  const response = await fetch(`${MOCK}/__test/add-sandboxes`, {
    method: "POST",
    body: JSON.stringify({ rows: busyFleet() }),
  });
  if (!response.ok) throw new Error(`seeding the busy fleet failed: ${response.status}`);
  // The mock's own running sandbox started its turn a quarter of an hour ago, like the rest of this busy day.
  await fetch(`${MOCK}/__test/sandbox-events`, {
    method: "POST",
    body: JSON.stringify({
      sandbox: "00000000-0000-4000-8000-000000000030",
      events: [
        prompt("a1", Date.now() - 15 * MIN, "Fix the failing test", "running"),
        message("a2", Date.now() - MIN, "Looking at the test suite.", "a1", [
          { id: "t1", name: "Read", input: { file_path: "test/clock.test.ts" } },
        ]),
      ],
    }),
  });
}
