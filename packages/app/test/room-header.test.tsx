import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Group } from "../src/fleet/overview";
import { Header, headerPills, staleReadings } from "../src/room/Header";

// The room's header (THE-2085) on synthetic counts: one pill per state that
// holds an agent, in the states' order, on its state's dot; a provider read
// long ago, quietly; the panel's toggle. A pill opening the panel on its group
// runs in a browser (test/room-panel.test.tsx).

const NOW = Date.parse("2026-03-10T15:00:00.000Z");
const counts = (n: Partial<Record<Group, number>>): Record<Group, number> => ({
  blocked: 0,
  you: 0,
  running: 0,
  ready: 0,
  merged: 0,
  ...n,
});

function render(
  n: Record<Group, number> | null,
  { open = true, readAt = undefined as Record<string, string> | undefined } = {},
) {
  return renderToStaticMarkup(
    <Header
      project={{ name: "Harbor", repository: "example/harbor" }}
      counts={n}
      readAt={readAt}
      now={NOW}
      open={open}
      panel="room-panel"
      onToggle={() => {}}
      onPill={() => {}}
    />,
  );
}

const pills = (html: string) =>
  [...html.matchAll(/<button type="button" data-pill="([a-z]+)"[^>]*>(.*?)<\/button>/g)].map((m) => {
    const dot = m[2]?.match(/rounded-full (bg-[a-z]+)/)?.[1];
    return `${m[1]} ${dot} ${m[2]?.replace(/<[^>]+>/g, "")}`;
  });

test("a pill per state that holds an agent, in the states' order, on its state's dot", () => {
  expect(pills(render(counts({ blocked: 1, you: 2, running: 3, ready: 4, merged: 37 })))).toEqual([
    "blocked bg-red 1 blocked",
    "you bg-amber 2 waiting for you",
    "running bg-blue 3 in progress",
    "ready bg-green 4 ready to merge",
    "merged bg-merged 37 merged today",
  ]);
  // Only the states that hold one; none at all while the project's log is read.
  expect(pills(render(counts({ blocked: 1, running: 2, merged: 37 })))).toEqual([
    "blocked bg-red 1 blocked",
    "running bg-blue 2 in progress",
    "merged bg-merged 37 merged today",
  ]);
  expect(headerPills(counts({}))).toEqual([]);
  expect(render(null)).not.toContain("data-pill");
});

test("the header names the project, its repository, and a provider read long ago quietly", () => {
  const html = render(counts({}), {
    readAt: { linear: new Date(NOW - 25 * 60_000).toISOString(), github: new Date(NOW - 120_000).toISOString() },
  });
  expect(html).toMatch(/<h1 class="[^"]*font-medium text-sub[^"]*">Harbor<\/h1>/);
  expect(html).toMatch(/<span class="[^"]*font-mono text-meta text-text-3">example\/harbor<\/span>/);
  expect(html).toMatch(
    /<span title="Linear last read at [^"]+" class="[^"]*text-text-3[^"]*" data-reading="linear">Linear 25 min ago<\/span>/,
  );
  // A fresh reading says nothing.
  expect(html).not.toContain("GitHub");
  expect(staleReadings({ linear: new Date(NOW - 180_000).toISOString() }, NOW)).toEqual([]);
  expect(staleReadings(undefined, NOW)).toEqual([]);
});

test("the panel's toggle says whether the panel is open", () => {
  const toggle = (html: string) => html.match(/<button[^>]*aria-label="Panel"[^>]*>/)?.[0] ?? "";
  expect(toggle(render(counts({})))).toContain('aria-pressed="true"');
  expect(toggle(render(counts({}), { open: false }))).toContain('aria-pressed="false"');
  expect(toggle(render(counts({})))).toContain('aria-controls="room-panel"');
  // Closed, there is no panel for it to name.
  expect(toggle(render(counts({}), { open: false }))).not.toContain("aria-controls");
});
