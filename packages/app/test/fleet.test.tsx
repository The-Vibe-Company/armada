import { expect, test } from "bun:test";
import { fold } from "@armada/daemon/fold";
import { PROTOCOL_VERSION } from "@armada/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { SAMPLE_PROJECTS, sampleEvents } from "../scripts/dev-daemon";
import { FleetList } from "../src/components/fleet/FleetList";
import { type FleetItem, LONG_LIST } from "../src/fleet/overview";
import { createDaemonClient, type SocketLike } from "../src/protocol/client";
import { DaemonProvider } from "../src/protocol/store";
import { Home } from "../src/screens/Home";

// The home on a synthetic fleet: the daemon's own fold of a synthetic log,
// handed to the app as the subscription hands it (a snapshot per project).

const AT = "2026-03-10T09:00:00.000Z";
const NOW = Date.parse("2026-03-10T15:00:00.000Z");

function render() {
  const events = sampleEvents(AT).map((e, i) => ({ ...e, seq: i + 1 }));
  const tables = fold(events);
  let socket: SocketLike | null = null;
  const client = createDaemonClient({
    url: "ws://daemon.test/",
    open: () => {
      socket = { send() {}, close() {}, onopen: null, onmessage: null, onclose: null };
      return socket;
    },
    schedule: () => () => {},
  });
  client.start();
  const say = (m: Record<string, unknown>) =>
    socket?.onmessage?.({ data: JSON.stringify({ version: PROTOCOL_VERSION, ...m }) });
  say({ type: "projects.result", id: "r1", projects: SAMPLE_PROJECTS });
  for (const p of SAMPLE_PROJECTS)
    say({
      type: "project.subscribed",
      id: `s-${p.id}`,
      subscriptionId: `sub-${p.id}`,
      project: p.id,
      after: 0,
      snapshot: { seq: events.length, state: JSON.parse(JSON.stringify(tables.projects[p.id] ?? { sessions: [] })) },
    });
  return renderToStaticMarkup(
    <DaemonProvider client={client}>
      <Home address="ws://daemon.test/" onReload={() => {}} now={NOW} zone="UTC" />
    </DaemonProvider>,
  );
}

/** The list as it reads: each group's header, then each row's ticket, group, reason and the reason's colour. */
function list(html: string) {
  return html
    .split(/(?=<h2\b|<a[^>]*data-row=)/)
    .slice(1)
    .map((block) => {
      if (block.startsWith("<h2")) {
        const [, label, count] = block.match(/<span>([^<]+)<\/span><span[^>]*>(\d+)<\/span>/) ?? [];
        return `${label} (${count})`;
      }
      const group = block.match(/data-group="([^"]+)"/)?.[1];
      const [, ink, reason] = block.match(/<span data-reason="true" class="[^"]* (text-[a-z0-9-]+)">([^<]*)</) ?? [];
      const dot = block.match(/<span aria-hidden="true" class="size-2 rounded-full (bg-[a-z]+)"/)?.[1];
      const ticket = block.match(/<span class="truncate font-mono[^"]*">([^<]+)</)?.[1];
      return `  ${ticket} ${group} ${dot} | ${reason} | ${ink}`;
    });
}

test("the home shows the fleet by state, each row with its reason in its state's colour", () => {
  const html = render();
  expect(list(html)).toEqual([
    "Blocked (2)",
    "  HAR-15 blocked bg-red | Red CI on #41 | text-red",
    "  LAN-3 blocked bg-red | Unanswered question: Should dawn follow the local sunrise or a fixed hour? | text-red",
    "Waiting for your decision (2)",
    "  HAR-18 you bg-amber | Plan to approve | text-amber",
    "  LAN-7 you bg-amber | Does the amber read as a lantern at night? | text-amber",
    "In progress (1)",
    "  HAR-12 running bg-blue | Wiring the map to the tide feed | text-text-2",
    "Ready to merge (1)",
    "  HAR-20 ready bg-green | Handed back · #44 green | text-green",
    "Merged today (1)",
    "  HAR-9 merged bg-merged | #39 merged | text-text-2",
  ]);
  // Every row is a link to its session's page (THE-2028): the whole row is the target.
  const rows = [...html.matchAll(/<a [^>]*data-row="([^"]+)"[^>]*>/g)];
  expect(rows).toHaveLength(7);
  for (const [tag, key] of rows) expect(tag).toContain(`href="#/sessions/${key?.split("/")[1]}"`);
  // The page's anatomy: the numbers on the facts line, what is blocked and what waits on the quiet line.
  expect(html).toContain("6 agents in flight across 3 projects");
  expect(html).toContain("2 agents blocked, 2 waiting for your decision.");
  // Each row's bar: the step at work in its state's colour (HAR-12 codes: step 3 of 6).
  const bar = html
    .split('data-row="harbor/HAR-12"')[1]
    ?.match(
      /<span role="img" aria-label="Step: Code"[^>]*>(.*?)<\/span><span class="whitespace-nowrap text-right/,
    )?.[1];
  expect(bar?.match(/bg-[a-z-]+/g)).toEqual([
    "bg-step-done",
    "bg-step-done",
    "bg-blue",
    "bg-step-next",
    "bg-step-next",
    "bg-step-next",
  ]);
});

test("past 100 rows, the rows off screen skip their layout and paint", () => {
  const items = (n: number): FleetItem[] =>
    Array.from({ length: n }, (_, k) => ({
      key: `p/EX-${k}`,
      project: "p",
      ticket: `EX-${k}`,
      title: `Ticket ${k}`,
      group: "running",
      reason: "At work",
      step: 2,
      at: AT,
    }));
  const html = (n: number) =>
    renderToStaticMarkup(<FleetList items={items(n)} names={new Map()} now={NOW} zone="UTC" />);
  const skipping = (markup: string) => markup.match(/\[content-visibility:auto\]/g)?.length ?? 0;
  expect(skipping(html(LONG_LIST))).toBe(0);
  expect(skipping(html(LONG_LIST + 1))).toBe(LONG_LIST + 1);
});
