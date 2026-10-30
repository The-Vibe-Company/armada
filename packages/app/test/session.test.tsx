import { expect, test } from "bun:test";
import { fold } from "@armada/daemon/fold";
import { type EventInput, PROTOCOL_VERSION } from "@armada/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { SAMPLE_PROJECTS, sampleEvents } from "../scripts/dev-daemon";
import { createDaemonClient, type SocketLike } from "../src/protocol/client";
import { DaemonProvider } from "../src/protocol/store";
import { Session } from "../src/screens/Session";
import { parseSessionRoute, sessionHref } from "../src/session/route";

// A session's page (THE-2028) on the daemon's own fold of a synthetic log,
// handed to the app as the subscription hands it: the folded state, then the
// events it replays. One session in each state.

const AT = "2026-03-10T09:00:00.000Z";
const LATER = "2026-03-10T09:30:00.000Z";
const NOW = Date.parse("2026-03-10T15:00:00.000Z");

/** The sample fleet, and a few lines more: HAR-15's pull request as the forge reads it, its later reports, HAR-18's plan. */
function log(): EventInput[] {
  const at = LATER;
  return [
    ...sampleEvents(AT),
    {
      project: "harbor",
      kind: "pull-request.opened",
      at,
      actor: "github",
      payload: {
        number: 41,
        ticket: "HAR-15",
        state: "open",
        ci: "failure",
        conflicting: false,
        head: "head-41",
        repository: "example/harbor",
        title: "Price berths by the hour",
        url: "https://example.test/harbor/pull/41",
        headRef: "feature/har-15-price-berths",
        draft: false,
        review: "none",
        checks: [],
        checksComplete: true,
        // The forge's files, when it reads them (additive to the payload).
        files: [
          { path: "src/berths/price.ts", additions: 42, deletions: 3 },
          { path: "test/price.test.ts", additions: 18, deletions: 0 },
        ],
      } as EventInput["payload"],
    } as EventInput,
    {
      project: "harbor",
      kind: "session.heartbeat",
      at,
      actor: "worker",
      payload: { ticket: "HAR-15", session: "s-har-15-1" },
    },
    {
      project: "harbor",
      kind: "inbox.opened",
      at,
      actor: "worker",
      payload: { id: "p-har-18", ticket: "HAR-18", kind: "plan", body: "1. Add a booking form.\n2. Test it." },
    },
    // Handed for validation before the coordinator opened one.
    {
      project: "harbor",
      kind: "ticket.seen",
      at,
      actor: "tracker",
      payload: { id: "HAR-30", title: "Light the quay", status: "started" },
    },
    {
      project: "harbor",
      kind: "session.claimed",
      at,
      actor: "worker",
      payload: {
        ticket: "HAR-30",
        session: "s-har-30-1",
        generation: 1,
        owner: "default",
        runtime: "claude",
        handle: "h",
      },
    },
    {
      project: "harbor",
      kind: "session.reported",
      at,
      actor: "worker",
      payload: { ticket: "HAR-30", session: "s-har-30-1", phase: "awaiting-validation", reason: "Lights on" },
    },
  ];
}

function render(
  ticket: string,
  tab: "reports" | "files" = "reports",
  inputs: EventInput[] = log(),
  version: { major: number; minor: number } = PROTOCOL_VERSION,
) {
  const events = inputs.map((e, i) => ({ ...e, seq: i + 1 }));
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
  const say = (m: Record<string, unknown>) => socket?.onmessage?.({ data: JSON.stringify({ version, ...m }) });
  say({ type: "projects.result", id: "r1", projects: SAMPLE_PROJECTS });
  for (const p of SAMPLE_PROJECTS) {
    const seq = events.length;
    say({
      type: "project.subscribed",
      id: `s-${p.id}`,
      subscriptionId: `sub-${p.id}`,
      project: p.id,
      after: 0,
      snapshot: { seq, state: JSON.parse(JSON.stringify(tables.projects[p.id] ?? { sessions: [] })) },
    });
    say({
      type: "events",
      subscriptionId: `sub-${p.id}`,
      project: p.id,
      seq,
      events: events.filter((e) => e.project === p.id),
    });
  }
  return renderToStaticMarkup(
    <DaemonProvider client={client}>
      <Session ticket={ticket} tab={tab} now={NOW} zone="UTC" />
    </DaemonProvider>,
  );
}

/** The page as it reads, in words: its parts' text, tags dropped. */
const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const part = (html: string, from: RegExp, to: string) => {
  const start = html.search(from);
  return start < 0 ? "" : html.slice(start, html.indexOf(to, start) + to.length);
};
const card = (html: string) => part(html, /<section aria-label="State"/, "</section>");
const steps = (html: string) =>
  [
    ...part(html, /<ol aria-label="Steps"/, "</ol>").matchAll(
      /<li data-step="([a-z]+)"[^>]*>.*?>([^<]+)<\/span><\/li>/g,
    ),
  ].map(([, state, label]) => `${label}:${state}`);

test("each state's card says the state, why, and what to do about it, edged in the state's colour", () => {
  const blocked = render("HAR-15");
  expect(card(blocked)).toContain('data-state="blocked"');
  expect(card(blocked)).toContain("border-red/55");
  // Blocked by its checks: nothing to answer; the worker can be released, its session opened.
  expect(words(card(blocked))).toBe("Blocked Red CI on #41 Release the ticket Open the session");
  // Each button acts once the daemon speaks the session's messages (THE-2045).
  expect(card(blocked)).not.toMatch(/<button[^>]*disabled=""/);

  // A worker's question blocks its session: the question, then Answer opens its choices.
  expect(words(card(render("LAN-3")))).toBe(
    "Blocked Should dawn follow the local sunrise or a fixed hour? Answer Release the ticket Open the session",
  );

  const validation = card(render("LAN-7"));
  expect(validation).toContain("border-amber/55");
  // Plans and validations are not decided here yet: their buttons stay disabled, the worker's do not.
  expect(words(validation)).toBe(
    "Waiting for you Does the amber read as a lantern at night? ✓ The amber is warm Approve Request changes Note Not available yet. Release the ticket Open the session",
  );
  expect(validation).toMatch(/<label[^>]*><span[^>]*>Note<\/span><input type="text" disabled=""/);
  expect(validation.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
  expect(words(card(render("HAR-18")))).toBe(
    "Waiting for you 1. Add a booking form. 2. Test it. Approve the plan Ask for changes Note Not available yet. Release the ticket Open the session",
  );

  // Waiting for a validation the coordinator has not opened yet: a validation's choices, not a plan's.
  expect(words(card(render("HAR-30")))).toBe(
    "Waiting for you Waiting for your validation Approve Request changes Note Not available yet. Release the ticket Open the session",
  );

  const running = card(render("HAR-12"));
  expect(running).toContain("border-blue/45");
  expect(words(running)).toBe(
    "In progress Last report 09:00 Wiring the map to the tide feed Release the ticket Open the session",
  );

  expect(words(card(render("HAR-20")))).toBe(
    "Ready to merge Handed back · #44 green Release the ticket Open the session",
  );
  const merged = card(render("HAR-9"));
  expect(merged).toContain("border-merged/45");
  expect(words(merged)).toBe("Merged #39 merged");
  // Released: no longer in the list, its page says so (an old link, or live while it is open).
  const released = render("LAN-4");
  expect(card(released)).toContain("border-merged/45");
  expect(words(card(released))).toBe("Released superseded");
  expect(released).toContain("Released: no worker holds this ticket now.");
});

test("the facts line, the ticket's title as the one h1, and the six steps with the current one marked", () => {
  const html = render("HAR-15");
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toMatch(/<h1[^>]*>Price berths by the hour<\/h1>/);
  const facts = words(part(html, /<header/, "<h1").replace(/<h1$/, ""));
  // The runtime names its harness here (codex), so the harness is not said twice.
  expect(facts).toBe(
    "← Harbor · HAR-15 · codex · feature/har-15-price-berths · #41 checks red · claimed 09:00 · last report 09:00",
  );
  // Back to the project's page (its room once it lands).
  expect(html).toContain('href="#/projects/harbor"');
  expect(html).toContain('href="https://example.test/harbor/pull/41"');
  expect(steps(html)).toEqual([
    "Plan:done",
    "Build:done",
    "Ship:done",
    "Review &amp; CI:current",
    "Merge:next",
    "Done:next",
  ]);
  expect(html).toMatch(/<li data-step="current" aria-current="step"/);
  expect(steps(render("HAR-18"))[0]).toBe("Plan:current");
  expect(steps(render("HAR-12"))[1]).toBe("Build:current");
  expect(steps(render("HAR-20"))[4]).toBe("Merge:current");
  expect(steps(render("HAR-9"))).toEqual([
    "Plan:done",
    "Build:done",
    "Ship:done",
    "Review &amp; CI:done",
    "Merge:done",
    "Done:current",
  ]);
});

test("the reports tab lists the session's reports and events newest first, each opening on a click", () => {
  const html = render("HAR-15");
  expect(html).toMatch(/<a aria-current="page" href="#\/sessions\/HAR-15"[^>]*>Reports/);
  const entries = [...html.matchAll(/<li data-entry="\d+"[^>]*>(.*?)<\/li>/g)].map(([, e]) => ({
    open: e?.startsWith("<details") ?? false,
    text: words(e ?? ""),
  }));
  // Heartbeats are left out; a line with a text opens on a click to show all of it.
  expect(entries).toEqual([
    { open: true, text: "09:30 #41 opened Price berths by the hour Price berths by the hour" },
    { open: false, text: "09:00 #41 seen, checks red" },
    { open: true, text: "09:00 Shipping Pull request open Pull request open" },
    { open: false, text: "09:00 Claimed on codex" },
  ]);
  // The first line cut with an ellipsis in one line; the whole text under it.
  expect(html).toMatch(/<summary class="[^"]*cursor-pointer[^"]*">.*?<span class="truncate/);
});

test("the files tab lists the pull request's files with their counts, or says there are none", () => {
  const html = render("HAR-15", "files");
  expect(html).toMatch(/<a aria-current="page" href="#\/sessions\/HAR-15\?tab=files"/);
  const files = [...html.matchAll(/<li data-file="[^"]+"[^>]*>(.*?)<\/li>/g)].map(([, f]) => words(f ?? ""));
  expect(files).toEqual(["src/berths/price.ts +42 −3", "test/price.test.ts +18 −0"]);
  expect(words(part(render("HAR-20", "files"), /<div data-tab=/, "</div>"))).toBe("No file of #44 read yet.");
  expect(words(part(render("HAR-12", "files"), /<div data-tab=/, "</div>"))).toBe("No pull request yet.");
});

test("a ticket no project holds says so under its id", () => {
  const html = render("NOPE-1");
  expect(html).toMatch(/<h1[^>]*><span class="font-mono">NOPE-1<\/span><\/h1>/);
  expect(html).toContain("No project of this daemon has a session on NOPE-1.");
});

test("the session's address: its ticket, and the files tab in the query", () => {
  expect(sessionHref("HAR-15")).toBe("#/sessions/HAR-15");
  expect(sessionHref("HAR 15", "files")).toBe("#/sessions/HAR%2015?tab=files");
  expect(parseSessionRoute("#/sessions/HAR%2015?tab=files")).toEqual({ ticket: "HAR 15", tab: "files" });
  expect(parseSessionRoute("#/sessions/HAR-15/")).toEqual({ ticket: "HAR-15", tab: "reports" });
  expect(parseSessionRoute("#/sessions/%E0")).toBeNull();
  expect(parseSessionRoute("#/projects/harbor")).toBeNull();
  expect(parseSessionRoute("")).toBeNull();
});

test("the session retains launch steps and branch after the worker claims", () => {
  const inputs: EventInput[] = [
    {
      project: "harbor",
      kind: "ticket.seen",
      at: AT,
      actor: "tracker",
      payload: { id: "HAR-99", title: "Launch the pilot", status: "unstarted" },
    },
  ];
  for (const step of ["preparing", "starting", "launched"] as const)
    inputs.push({
      project: "harbor",
      kind: "coordinator.checkpoint",
      at: AT,
      actor: "coordinator",
      payload: {
        checkpoint: {
          format: "armada.worker",
          version: 1,
          type: step === "preparing" ? "launch-intent" : "launch",
          ticket: "HAR-99",
          session: "new",
          generation: 1,
          runtime: "claude",
          branch: "worker/har-99",
          step,
        },
      },
    });
  expect(words(card(render("HAR-99", "reports", inputs)))).toContain("Launched; waiting for worker claim");
  inputs.push({
    project: "harbor",
    kind: "session.claimed",
    at: LATER,
    actor: "worker",
    payload: { ticket: "HAR-99", session: "new", generation: 1, owner: "default", runtime: "claude", handle: "cli" },
  });
  const page = words(render("HAR-99", "reports", inputs));
  expect(page).toContain("Preparing workspace");
  expect(page).toContain("Starting worker CLI");
  expect(page).toContain("Launched on claude");
  expect(page).toContain("worker/har-99");
  expect(page).toContain("Claimed on claude");
});

test("the coordinator's question to the owner shows its choices and a labelled note at once", () => {
  const inputs: EventInput[] = [
    ...log(),
    {
      project: "harbor",
      kind: "inbox.opened",
      at: LATER,
      actor: "coordinator",
      payload: {
        id: "ask-har-30",
        ticket: "HAR-30",
        kind: "owner-request",
        body: "Warm or cold light?\n\nOptions:\n1. Warm (recommended)\n2. Cold",
      },
    },
  ];
  const html = card(render("HAR-30", "reports", inputs));
  expect(words(html)).toBe(
    "Waiting for you Warm or cold light? Warm · recommended Cold Note Release the ticket Open the session",
  );
  expect(html).toMatch(/<form aria-label="Answer"/);
  expect(html).toMatch(/<label for="([^"]+)-note"[^>]*>Note<\/label><input id="\1-note"/);
  expect(html).not.toMatch(/<button[^>]*disabled=""/);
});

test("a V1 session opens its Conductor workspace, and is released from its own runtime", () => {
  const inputs: EventInput[] = [
    ...log(),
    {
      project: "harbor",
      kind: "ticket.seen",
      at: AT,
      actor: "tracker",
      payload: {
        id: "HAR-40",
        title: "Paint the buoys",
        status: "started",
        phase: "implementing",
        // Newest first, as the tracker hands them: the latest claim, under its status line, wins.
        comments: [
          { body: "Agent status: implementing — painting", author: "A. Worker", at: LATER },
          {
            body: "Agent status: planning — claimed by Conductor (ws-7/s-3)\n\nAgent claim — runtime: conductor · session: ws-7/s-3 · branch: feature/har-40 · started: 2026-03-10",
            author: "A. Worker",
            at: AT,
          },
          {
            body: "Agent status: planning — claimed by Conductor (ws-1/s-1)\n\nAgent claim — runtime: conductor · session: ws-1/s-1 · branch: feature/har-40 · started: 2026-03-09",
            author: "A. Worker",
            at: AT,
          },
        ],
      },
    },
  ];
  const html = card(render("HAR-40", "reports", inputs));
  expect(html).toMatch(/<a href="conductor:\/\/workspace\?id=ws-7"[^>]*>Open the session<\/a>/);
  expect(words(html)).toBe(
    "In progress Last report 09:00 At work Release the ticket Open the session A V1 session: release it from its own runtime with armada stop.",
  );
  expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(1);
});

test("against an older daemon the buttons wait, saying why", () => {
  const html = card(render("LAN-3", "reports", log(), { major: 1, minor: 5 }));
  expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(3);
  expect(words(html)).toContain("This daemon is older than the app: update it to act on a session.");
});
