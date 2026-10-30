import { expect, test } from "bun:test";
import { fold } from "@armada/daemon/fold";
import { renderToStaticMarkup } from "react-dom/server";
import { sampleEvents } from "../scripts/dev-daemon";
import { FleetList } from "../src/components/fleet/FleetList";
import { type FleetItem, fleetItems, LONG_LIST } from "../src/fleet/overview";
import { readFleetState } from "../src/fleet/state";

// A project's agents by state (the room's panel's Agents, THE-2085) on a
// synthetic fleet: the daemon's own fold of a synthetic log, read as the app
// reads each project's folded state.

const AT = "2026-03-10T09:00:00.000Z";
const NOW = Date.parse("2026-03-10T15:00:00.000Z");

function render(project = "harbor", prefixes = "HAR") {
  const events = sampleEvents(AT).map((e, i) => ({ ...e, seq: i + 1 }));
  const tables = fold(events);
  const state = readFleetState(JSON.parse(JSON.stringify(tables.projects[project] ?? { sessions: [] })));
  return renderToStaticMarkup(
    <FleetList
      items={fleetItems([{ id: project, state }], { now: NOW, zone: "UTC" })}
      harnessOf={() => null}
      repository={`example/${project}`}
      prefixes={prefixes}
      now={NOW}
      zone="UTC"
    />,
  );
}

/** The list as it reads: each group's heading, then each row's ticket, group, report and the report's colour. */
function list(html: string) {
  return html
    .split(/(?=<h2\b|<div[^>]*data-row=|<p\b)/)
    .slice(1)
    .map((block) => {
      if (block.startsWith("<h2")) {
        const [, label, count] = block.match(/<\/span>([^<]+)<span[^>]*>(\d+)<\/span>/) ?? [];
        return `${label} (${count})`;
      }
      if (block.startsWith("<p")) return `  ${block.match(/<p[^>]*>([^<]+)</)?.[1]}`;
      const group = block.match(/data-group="([^"]+)"/)?.[1];
      const [, ink, report] =
        block.match(/<span data-reason="true" class="[^"]* (text-[a-z0-9-]+)">(.*?)<\/span><\/span>/) ?? [];
      const ticket = block.match(/<span class="mr-2 font-mono[^"]*">([^<]+)</)?.[1];
      return `  ${ticket} ${group} | ${report?.replace(/<[^>]+>/g, "") ?? "-"} | ${ink ?? "-"}`;
    });
}

test("a project's agents by state, every group headed, each row with its report in its state's colour", () => {
  const html = render();
  expect(list(html)).toEqual([
    "Blocked (1)",
    "  HAR-15 blocked | Red CI on #41 | text-red",
    "Waiting for your decision (1)",
    "  HAR-18 you | Plan to approve | text-amber",
    "In progress (1)",
    "  HAR-12 running | Wiring the map to the tide feed | text-text-3",
    "Ready to merge (1)",
    "  HAR-20 ready | Handed back · #44 green | text-green",
    "Merged today (1)",
    "  HAR-9 merged | - | -",
  ]);
  // Each heading can take the focus: a pill of the room's header goes to it.
  expect(html).toMatch(/<h2 id="agents-blocked" tabindex="-1" data-group-heading="blocked"/);
  // Each row's title is its link to the session's page, stretched over the row (THE-2028).
  const links = [...html.matchAll(/<a href="([^"]+)" data-open="true" aria-describedby="agents-([a-z]+)"/g)];
  expect(links.map((m) => `${m[1]} ${m[2]}`)).toEqual([
    "#/sessions/HAR-15 blocked",
    "#/sessions/HAR-18 you",
    "#/sessions/HAR-12 running",
    "#/sessions/HAR-20 ready",
    "#/sessions/HAR-9 merged",
  ]);
  // The ids a report names link on their own: `#41` to its pull request on the project's repository.
  expect(html).toMatch(
    /<a href="https:\/\/github.com\/example\/harbor\/pull\/41" target="_blank" rel="noreferrer" data-pr="#41"/,
  );
});

test("an empty group says so; a report's ticket ids link only under the project's prefixes", () => {
  const item: FleetItem = {
    key: "harbor/HAR-2",
    project: "harbor",
    ticket: "HAR-2",
    title: "Moor the ferries",
    group: "blocked",
    reason: "Waits on HAR-12, UTF-8 and #7",
    step: 2,
    at: AT,
  };
  const html = renderToStaticMarkup(
    <FleetList items={[item]} harnessOf={() => null} repository="example/harbor" prefixes="HAR" now={NOW} zone="UTC" />,
  );
  expect(list(html)).toEqual([
    "Blocked (1)",
    "  HAR-2 blocked | Waits on HAR-12, UTF-8 and #7 | text-red",
    "Waiting for your decision (0)",
    "  Nothing waits for you.",
    "In progress (0)",
    "  Nothing in progress.",
    "Ready to merge (0)",
    "  Nothing is ready to merge.",
    "Merged today (0)",
    "  Nothing merged today.",
  ]);
  const links = [...html.matchAll(/<a href="([^"]+)"[^>]*data-(?:ticket|pr)="([^"]+)"/g)].map((m) => `${m[2]} ${m[1]}`);
  expect(links).toEqual(["HAR-12 #/sessions/HAR-12", "#7 https://github.com/example/harbor/pull/7"]);
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
    renderToStaticMarkup(
      <FleetList items={items(n)} harnessOf={() => null} repository="example/p" prefixes="EX" now={NOW} zone="UTC" />,
    );
  const skipping = (markup: string) => markup.match(/\[content-visibility:auto\]/g)?.length ?? 0;
  expect(skipping(html(LONG_LIST))).toBe(0);
  expect(skipping(html(LONG_LIST + 1))).toBe(LONG_LIST + 1);
});
