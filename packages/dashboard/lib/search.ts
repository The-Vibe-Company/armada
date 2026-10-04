// ⌘K's index (THE-892: apart from fleet-view.ts, so it loads with the
// palette, not with every page; THE-895: everything the fleet knows). The
// items come from the overview the shell polls (agents, tickets ready to
// start, open pull requests, projects, validations) and from the search
// index /api/fleet/search serves once, lazily, tagged (every ticket of each
// project's last reading, done ones of the last 30 days, the pull requests
// GitHub gave, the attachments' captions): never from Linear or GitHub while
// typing. Pure: ranking, grouping and the recent picks are tested here, and
// a query over thousands of items stays far under 50 ms.
import type { FleetOverview, Issue, PullRequest, StatusSources, StatusType } from "@armada/core/read";
import { type SavedView, viewHref } from "./filters";
import { type AgentState, agentState, paths } from "./fleet-view";
import { LANGUAGES, type Language, type Strings } from "./i18n";
import { decisionCards } from "./overview-view";
import { coordinatorLink } from "./project-view";

/** Each language in its own words, whatever the page's. */
const LANGUAGE_NAMES: Record<Language, string> = { en: "English", fr: "Français" };

/** Done tickets stay findable this long after they closed. */
export const DONE_SEARCH_DAYS = 30;
const DAY_MS = 24 * 3_600_000;

// --------------------------------------------------------------- the index route

/** A ticket of a project's last reading of Linear. */
export interface IndexTicket {
  project: string;
  id: string;
  title: string;
  url: string;
  /** Linear's status name: "Done", "In Review". */
  status: string;
  statusType: StatusType;
  updatedAt: string;
  /** Its pull request's head branch, when one is known. */
  branch: string | null;
}

/** A pull request GitHub gave: the open ones and those closed lately. */
export interface IndexPr {
  project: string;
  number: number;
  title: string;
  url: string;
  branch: string | null;
  state: "open" | "merged" | "closed";
  ticket: string | null;
  updatedAt: string | null;
}

/** An attachment with a caption (THE-886's evidence), metadata only. */
export interface IndexAttachment {
  project: string;
  id: string;
  ticket: string;
  caption: string;
  kind: "image" | "link";
  /** A link's address; an image is served by /api/attachments/<id>. */
  url: string | null;
  createdAt: string;
}

/** What /api/fleet/search answers: what the polled overview does not carry. */
export interface SearchIndex {
  tickets: IndexTicket[];
  prs: IndexPr[];
  attachments: IndexAttachment[];
}

export const EMPTY_INDEX: SearchIndex = { tickets: [], prs: [], attachments: [] };

const TICKET_IN_BRANCH = /(?:^|[/_-])([a-z][a-z0-9]{0,9}-\d{1,7})(?=$|[/_-])/i;

/** A project's part of the index, from its last reading: Postgres only, nothing is read from Linear or GitHub. */
export function indexOfReading(
  project: string,
  sources: Pick<StatusSources, "program" | "forge">,
  now: Date,
): Pick<SearchIndex, "tickets" | "prs"> {
  const since = now.getTime() - DONE_SEARCH_DAYS * DAY_MS;
  const forge = new Map((sources.forge?.prs ?? []).map((p) => [p.number, p]));
  const issues = sources.program.issues;
  const ids = new Set(issues.map((i) => i.id));
  const ticketOf = new Map<number, string>();
  for (const i of issues) for (const p of i.prs) ticketOf.set(p.number, i.id);

  const kept = (i: Issue) => {
    if (i.statusType === "canceled") return false;
    if (i.statusType !== "completed") return true;
    const closed = Date.parse(i.completedAt ?? i.updatedAt);
    return Number.isFinite(closed) && closed >= since;
  };
  const branchOf = (i: Issue) => {
    for (const p of [...i.prs].reverse()) {
      const head = forge.get(p.number)?.headRef ?? p.headRef;
      if (head) return head;
    }
    return null;
  };
  const tickets = issues.filter(kept).map(
    (i): IndexTicket => ({
      project,
      id: i.id,
      title: i.title,
      url: i.url,
      status: i.status,
      statusType: i.statusType,
      updatedAt: i.completedAt ?? i.updatedAt,
      branch: branchOf(i),
    }),
  );
  const prState = (p: PullRequest): IndexPr["state"] => p.state ?? (p.mergedAt ? "merged" : "open");
  const prs = [...forge.values()].map((p): IndexPr => {
    const named = p.headRef?.match(TICKET_IN_BRANCH)?.[1]?.toUpperCase();
    return {
      project,
      number: p.number,
      title: p.title,
      url: p.url,
      branch: p.headRef ?? null,
      state: prState(p),
      ticket: ticketOf.get(p.number) ?? (named && ids.has(named) ? named : null),
      updatedAt: p.updatedAt ?? p.createdAt ?? null,
    };
  });
  return { tickets, prs };
}

// ------------------------------------------------------------------- the items

export type SearchKind = "agent" | "ticket" | "pr" | "validation" | "project" | "attachment" | "action" | "page";

/** The groups, in the order they show when no query ranks them. */
export const SEARCH_KINDS: readonly SearchKind[] = [
  "agent",
  "ticket",
  "pr",
  "validation",
  "project",
  "attachment",
  "action",
  "page",
];

/** What an action of the palette does; each goes through the same function as its button. */
export type PaletteAction =
  | { kind: "launch"; project: string; ticket: string; profile: string | null }
  | { kind: "answer"; project: string; item: number }
  | { kind: "copy"; text: string }
  | { kind: "language"; to: Language };

export interface SearchItem {
  kind: SearchKind;
  /** Unique within the list, and what the recent picks remember. */
  key: string;
  label: string;
  /** What shows on the right: an id, a state, a repository. */
  detail: string;
  /** Where Enter goes; null for an action run in place. */
  href: string | null;
  /** Opens outside the app (Linear, GitHub, Conductor), in a new tab. */
  external: boolean;
  project: string | null;
  /** For an agent: its status. */
  state: AgentState | null;
  /** What a query may name exactly: a ticket id, a pull request's number (`#12`), lowercase. */
  id: string | null;
  /** When it last moved, for ties; null when unknown. */
  at: string | null;
  /** A done ticket or a closed pull request: below what is open. */
  closed: boolean;
  action: PaletteAction | null;
  /** Lowercase: the label alone, then everything a query is matched against. */
  name: string;
  hay: string;
}

/** What the items' words and actions depend on besides the data. */
export interface SearchContext {
  t: Strings;
  lang: Language;
  /** Signed in with accounts: the organization's pages are listed. */
  organization: boolean;
  /** The live data answers: a launch or an answer can be sent. */
  live: boolean;
  /** The viewer's saved views (THE-895), found here since the menu lost them (THE-916). */
  views?: readonly Pick<SavedView, "id" | "name" | "list" | "query">[];
}

type Overview = Pick<FleetOverview, "rows" | "projects" | "ready" | "waiting"> &
  Partial<Pick<FleetOverview, "validations">>;

function item(
  base: Omit<SearchItem, "name" | "hay" | "external" | "state" | "id" | "at" | "closed" | "action"> &
    Partial<Pick<SearchItem, "external" | "state" | "id" | "at" | "closed" | "action">>,
  words: (string | null | undefined)[],
): SearchItem {
  return {
    external: false,
    state: null,
    at: null,
    closed: false,
    action: null,
    ...base,
    id: base.id ? base.id.toLowerCase() : null,
    name: base.label.toLowerCase(),
    hay: [base.label, base.detail, ...words].filter(Boolean).join(" ").toLowerCase(),
  };
}

/** Everything ⌘K reaches, built once per overview and index: the query only ranks them. */
export function searchItems(overview: Overview, index: SearchIndex | null, ctx: SearchContext): SearchItem[] {
  const { t } = ctx;
  const p = t.shell.palette;
  const names = new Map(overview.projects.map((x) => [x.slug, x.name]));
  const nameOf = (slug: string) => names.get(slug) ?? slug;
  const inFlight = new Map(overview.rows.map((r) => [`${r.project}:${r.id}`, r]));
  const ready = new Set(overview.ready.map((r) => `${r.project}:${r.id}`));
  const out: SearchItem[] = [];

  for (const r of overview.rows) {
    const branch = r.session?.branch ?? null;
    out.push(
      item(
        {
          kind: "agent",
          key: `agent:${r.project}:${r.id}`,
          label: r.title,
          detail: r.id,
          href: paths.agent(r.id),
          project: r.project,
          state: agentState(r),
          id: r.id,
          at: r.lastReport ?? r.lastUpdate,
        },
        [nameOf(r.project), r.runtime, branch, r.profile, r.session?.handle, t.shell.phases[r.phase]],
      ),
    );
  }
  for (const r of overview.ready)
    out.push(
      item(
        {
          kind: "ticket",
          key: `ticket:${r.project}:${r.id}`,
          label: r.title,
          detail: p.ready(r.id),
          href: paths.project(r.project),
          project: r.project,
          id: r.id,
        },
        [nameOf(r.project), ...r.labels],
      ),
    );
  for (const x of index?.tickets ?? []) {
    const key = `${x.project}:${x.id}`;
    if (inFlight.has(key) || ready.has(key)) continue;
    out.push(
      item(
        {
          kind: "ticket",
          key: `ticket:${key}`,
          label: x.title,
          detail: `${t.shell.palette.ticketStates[x.statusType]} · ${x.id}`,
          href: x.url,
          external: true,
          project: x.project,
          id: x.id,
          at: x.updatedAt,
          closed: x.statusType === "completed",
        },
        [nameOf(x.project), x.branch, x.status],
      ),
    );
  }

  // Pull requests: the open ones the overview carries, then those the index adds.
  const prSeen = new Set<string>();
  const pr = (x: IndexPr) => {
    const key = `${x.project}:${x.number}`;
    if (prSeen.has(key)) return;
    prSeen.add(key);
    const row = x.ticket ? inFlight.get(`${x.project}:${x.ticket}`) : undefined;
    out.push(
      item(
        {
          kind: "pr",
          key: `pr:${key}`,
          label: x.title,
          detail: p.pr(x.number, t.shell.palette.prStates[x.state]),
          href: row ? `${paths.agent(row.id)}?tab=files` : x.url,
          external: !row,
          project: x.project,
          id: `#${x.number}`,
          at: x.updatedAt,
          closed: x.state !== "open",
        },
        [String(x.number), x.branch, x.ticket, nameOf(x.project)],
      ),
    );
  };
  for (const proj of overview.projects)
    for (const x of proj.pullRequests ?? [])
      pr({
        project: proj.slug,
        number: x.number,
        title: x.title,
        url: x.url,
        branch: x.branch,
        state: "open",
        ticket: x.ticket?.id ?? null,
        updatedAt: x.updatedAt,
      });
  for (const x of index?.prs ?? []) pr(x);

  for (const v of overview.validations ?? []) {
    const open = !v.decision;
    out.push(
      item(
        {
          kind: "validation",
          key: `validation:${v.project}:${v.id}`,
          label: v.title ?? v.what,
          detail: p.validation(v.id, open),
          href: paths.validation(v.id),
          project: v.project,
          at: v.decision?.at ?? v.createdAt,
          closed: !open,
        },
        [v.ticket, v.what, v.reason, nameOf(v.project), ...v.gallery.map((a) => a.caption)],
      ),
    );
  }

  for (const x of overview.projects)
    out.push(
      item(
        {
          kind: "project",
          key: `project:${x.slug}`,
          label: x.name,
          detail: x.repository,
          href: paths.coordinator(x.slug),
          project: x.slug,
        },
        [x.slug, x.programRoot?.id, x.programRoot?.title],
      ),
    );

  for (const a of index?.attachments ?? []) {
    const row = inFlight.get(`${a.project}:${a.ticket}`);
    out.push(
      item(
        {
          kind: "attachment",
          key: `attachment:${a.id}`,
          label: a.caption,
          detail: a.ticket,
          href: row
            ? `${paths.agent(row.id)}?tab=attachments`
            : (a.url ?? `/api/attachments/${encodeURIComponent(a.id)}`),
          external: !row,
          project: a.project,
          at: a.createdAt,
        },
        [nameOf(a.project)],
      ),
    );
  }

  out.push(...actions(overview, index, ctx, nameOf));
  out.push(...pages(ctx));
  return out;
}

function actions(
  overview: Overview,
  index: SearchIndex | null,
  ctx: SearchContext,
  nameOf: (slug: string) => string,
): SearchItem[] {
  const { t } = ctx;
  const p = t.shell.palette;
  const out: SearchItem[] = [];
  const verbs = (...english: string[]) => english;

  // The oldest question or plan the owner may answer: the overview's own card, in the palette.
  const oldest = decisionCards(overview).find(
    (w) => (w.kind === "question" || w.kind === "approval") && w.item !== null && w.answer === null,
  );
  if (oldest && oldest.item !== null && ctx.live)
    out.push(
      item(
        {
          kind: "action",
          key: "action:answer",
          label: p.answerOldest(oldest.ticket ?? nameOf(oldest.project)),
          detail: oldest.title ?? nameOf(oldest.project),
          href: null,
          project: oldest.project,
          action: { kind: "answer", project: oldest.project, item: oldest.item },
        },
        verbs("answer", "decision", "approve", "plan", "question", oldest.ticket ?? ""),
      ),
    );
  if (ctx.live)
    for (const r of overview.ready)
      if (r.readyForAgent && !r.launch)
        out.push(
          item(
            {
              kind: "action",
              key: `action:launch:${r.project}:${r.id}`,
              label: p.launch(r.id),
              detail: r.title,
              href: null,
              project: r.project,
              action: { kind: "launch", project: r.project, ticket: r.id, profile: r.route?.profile ?? null },
            },
            verbs("launch", "start", nameOf(r.project)),
          ),
        );
  for (const x of overview.projects) {
    const link = coordinatorLink(x.coordinator);
    if (link)
      out.push(
        item(
          {
            kind: "action",
            key: `action:coordinator:${x.slug}`,
            label: p.coordinator(x.name),
            detail: x.coordinator.handle ?? "",
            href: link,
            external: true,
            project: x.slug,
          },
          verbs("open", "coordinator", "session", "conductor"),
        ),
      );
  }
  const branches = new Map<string, { project: string; branch: string }>();
  for (const r of overview.rows) {
    const b = r.session?.branch;
    if (b) branches.set(r.id, { project: r.project, branch: b });
  }
  for (const x of index?.tickets ?? [])
    if (x.branch && !branches.has(x.id)) branches.set(x.id, { project: x.project, branch: x.branch });
  for (const [ticket, { project, branch }] of branches)
    out.push(
      item(
        {
          kind: "action",
          key: `action:copy:${project}:${ticket}`,
          label: p.copyBranch(ticket),
          detail: branch,
          href: null,
          project,
          action: { kind: "copy", text: branch },
        },
        verbs("copy", "branch", "git"),
      ),
    );
  for (const lang of LANGUAGES)
    if (lang !== ctx.lang)
      out.push(
        item(
          {
            kind: "action",
            key: `action:language:${lang}`,
            label: p.language(LANGUAGE_NAMES[lang]),
            detail: lang.toUpperCase(),
            href: null,
            project: null,
            action: { kind: "language", to: lang },
          },
          verbs("language", "langue", "english", "français", "french"),
        ),
      );
  return out;
}

/** The pages ⌘K goes to, with the words they answer to in English whatever the language. */
function pages(ctx: SearchContext): SearchItem[] {
  const { t } = ctx;
  const nav = [
    ["overview", paths.overview, t.shell.nav.overview],
    ["validations", paths.validations, t.shell.nav.validations],
    ["projects", paths.projects, t.shell.nav.projects],
    ["insights", paths.insights, t.shell.nav.insights],
    ["activity", paths.activity, t.shell.nav.activity],
    ...(ctx.organization
      ? ([
          ["organization", "/organization", t.org.nav],
          ["keys", "/organization/keys", t.keys.nav],
          ["github", "/organization/github", t.github.nav],
          ["workers", "/organization/workers", t.workers.nav],
        ] as const)
      : []),
  ] as const;
  // The Agents page is the overview since THE-916: it still answers to "agents".
  const words = (key: string) => (key === "overview" ? ["agents", "coordinators", t.shell.coordinators] : []);
  return [
    ...nav.map(([key, href, name]) =>
      item(
        {
          kind: "page",
          key: `page:${key}`,
          label: t.shell.palette.goTo(name),
          detail: "",
          href,
          project: null,
        },
        [key, name, "go", "page", ...words(key)],
      ),
    ),
    ...(ctx.views ?? []).map((v) =>
      item(
        {
          kind: "page",
          key: `view:${v.id}`,
          label: v.name,
          detail: t.views.heading,
          href: viewHref(v),
          project: null,
        },
        ["view", "saved", t.views.heading],
      ),
    ),
  ];
}

// ------------------------------------------------------------------- ranking

/** A ticket id as typed: `the-12`, ` THE-12 `. */
export function ticketIdOf(query: string): string | null {
  const m = query.trim().match(/^([a-z][a-z0-9]{0,9}-\d{1,7})$/i);
  return m?.[1] ? m[1].toUpperCase() : null;
}

const KIND_BONUS: Record<SearchKind, number> = {
  agent: 30,
  project: 25,
  ticket: 20,
  pr: 15,
  validation: 15,
  action: 10,
  page: 5,
  attachment: 0,
};

/**
 * How far apart the query's letters sit in `text`, in order (fzf's idea, one
 * greedy pass back from the first full match): null when they are not all there.
 */
function span(text: string, q: string): number | null {
  let end = 0;
  for (const ch of q) {
    const found = text.indexOf(ch, end);
    if (found < 0) return null;
    end = found + 1;
  }
  // Walk back from that end to the latest start, so "abc" in "a…ab-c" counts "ab-c".
  let at = end - 1;
  for (let k = q.length - 1; k >= 0; k--) at = text.lastIndexOf(q[k] ?? "", at) - 1;
  return end - (at + 1);
}

/**
 * How well an item answers a lowercase query; 0 when it does not. Letters in
 * order (`fuzzy`) are matched on the label only, and only when they sit close:
 * across a ticket's whole text they would find anything. Pure and cheap: no
 * allocation on the common path.
 */
export function scoreOf(i: SearchItem, q: string, words: readonly string[], fuzzy = true): number {
  let s = 0;
  if (i.id !== null && (i.id === q || (i.kind === "pr" && i.id === `#${q}`))) s = 1000;
  else if (i.id !== null && q.length > 1 && (i.id.startsWith(q) || (i.kind === "pr" && i.id.startsWith(`#${q}`))))
    s = 700;
  else if (i.name.startsWith(q)) s = 600;
  else if (i.name.includes(` ${q}`)) s = 500;
  else if (i.name.includes(q)) s = 420;
  else if (i.hay.includes(q)) s = 350;
  else if (words.length > 1 && words.every((w) => i.hay.includes(w))) s = 300;
  else if (fuzzy && q.length > 2) {
    const found = span(i.name, q);
    // Tighter is better: at least one letter of the query in three letters of the label.
    if (found === null || found > q.length * 3) return 0;
    s = 100 + Math.round((q.length / found) * 100);
  } else return 0;
  return s + KIND_BONUS[i.kind] - (i.closed ? 15 : 0);
}

export interface SearchGroup {
  key: SearchKind | "recent";
  items: SearchItem[];
}

/** How many recent picks the palette remembers, in this browser. */
export const RECENT_MAX = 8;
export const RECENT_STORAGE = "armada-palette-recent";

/** The recent picks with `key` first. */
export const pushRecent = (recent: readonly string[], key: string): string[] =>
  [key, ...recent.filter((k) => k !== key)].slice(0, RECENT_MAX);

/** What the palette shows without a query: the recent picks, a few actions, the pages. */
function defaults(items: SearchItem[], recent: readonly string[]): SearchGroup[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const recents = recent.flatMap((k) => byKey.get(k) ?? []).slice(0, 6);
  const shown = new Set(recents.map((i) => i.key));
  const acts = items.filter(
    (i) => i.kind === "action" && !shown.has(i.key) && (i.action?.kind === "answer" || i.action?.kind === "language"),
  );
  const launches = items.filter((i) => i.action?.kind === "launch" && !shown.has(i.key)).slice(0, 2);
  const pageItems = items.filter((i) => i.kind === "page" && !shown.has(i.key));
  return [
    { key: "recent" as const, items: recents },
    { key: "action" as const, items: [...acts.slice(0, 1), ...launches, ...acts.slice(1)] },
    { key: "page" as const, items: pageItems },
  ].filter((g) => g.items.length > 0);
}

/**
 * The palette's results for a query, grouped by kind: the group holding the
 * best match first, each group best first. A ticket id typed whole puts that
 * ticket (or its agent) on top. Ties go to the viewer's recent picks, then to
 * what moved last. Without a query: the recent picks, actions and pages.
 */
export function search(
  items: SearchItem[],
  query: string,
  { recent = [], perGroup = 6, total = 36 }: { recent?: readonly string[]; perGroup?: number; total?: number } = {},
): SearchGroup[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return defaults(items, recent);
  const words = q.split(" ");
  // An id or a number is typed exactly: its letters scattered in a title are not what was meant.
  const fuzzy = !ticketIdOf(q) && !/^#?\d+$/.test(q);
  const rank = new Map(recent.map((k, n) => [k, n]));
  const hits: { i: SearchItem; s: number; k: number }[] = [];
  for (let k = 0; k < items.length; k++) {
    const i = items[k] as SearchItem;
    let s = scoreOf(i, q, words, fuzzy);
    if (!s) continue;
    const r = rank.get(i.key);
    if (r !== undefined) s += 60 - r * 5;
    hits.push({ i, s, k });
  }
  hits.sort((a, b) => b.s - a.s || (b.i.at ?? "").localeCompare(a.i.at ?? "") || a.k - b.k);
  const groups = new Map<SearchKind, SearchItem[]>();
  let count = 0;
  for (const h of hits) {
    if (count >= total) break;
    const list = groups.get(h.i.kind) ?? [];
    if (list.length >= perGroup) continue;
    list.push(h.i);
    groups.set(h.i.kind, list);
    count++;
  }
  // Map keeps insertion order: the group of the best hit first.
  return [...groups].map(([key, list]) => ({ key, items: list }));
}

/** The results one after another, as ↑/↓ moves through them. */
export const flatten = (groups: SearchGroup[]): SearchItem[] => groups.flatMap((g) => g.items);
