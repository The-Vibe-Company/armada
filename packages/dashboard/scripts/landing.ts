// The landing's terminal and its share image (THE-887), written by Armada's
// own code, never typed or drawn by hand:
//   bun run landing    writes components/landing/transcript.ts and
//                      app/landing/opengraph-image.png
// `armada status` is the CLI's renderStatus over the demo world's Widgets
// project; `armada watch` is core's readInbox over the demo world's inbox and
// workers, rendered by the CLI's renderEntries and the re-arm line. Run it
// after a change to either, or to the demo world: test/landing.test.ts fails until then.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  buildStatus,
  configTemplate,
  type FleetStore,
  type InboxItem,
  type LatestEvent,
  parseConfig,
  type RuntimeHandle,
  readInbox,
  rearm,
} from "@armada/core";
import { renderEntries } from "../../cli/src/inbox";
import { renderStatus } from "../../cli/src/render";
import type { TerminalCommand } from "../components/landing/terminal-types";
import { markSvg } from "../components/shell/Logo";
import { DEMO_INBOX, DEMO_PROJECTS, demoEvents, demoSnapshot } from "../lib/demo/world";

/** The moment the session is recorded at: the transcript says "12 min ago", not a date that ages. */
export const RECORDED_AT = new Date("2026-10-01T13:42:00Z");

const PROJECT = "widgets";

export async function landingTranscript(now = RECORDED_AT): Promise<TerminalCommand[]> {
  const project = DEMO_PROJECTS.find((p) => p.slug === PROJECT);
  if (!project) throw new Error(`the demo world has no ${PROJECT} project`);
  const config = parseConfig(configTemplate(project));
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

  const { program, forge } = demoSnapshot(project, "fleet", now);
  const status = renderStatus(buildStatus({ config, program, forge, now }));

  // The project's live data as Armada holds it: the inbox, each worker's claim and its last report.
  const workers = demoEvents("fleet").filter((e) => e.project === PROJECT);
  const items: InboxItem[] = DEMO_INBOX.filter((i) => i.project === PROJECT).map((i, k) => ({
    id: 12 + k,
    project: PROJECT,
    ticket: i.ticket,
    kind: i.kind,
    recipient: "coordinator",
    author: i.author,
    body: i.body,
    createdAt: ago(i.ago),
  }));
  const handles: RuntimeHandle[] = workers.map((w) => ({
    project: PROJECT,
    ticket: w.ticket,
    runtime: w.runtime,
    handle: w.handle,
    branch: `feature/${w.ticket.toLowerCase()}`,
    claimedAt: ago(w.claimed),
    releasedAt: null,
    profile: w.profile,
  }));
  const events: Record<string, LatestEvent> = Object.fromEntries(
    workers.map((w) => [
      w.ticket,
      {
        kind: "report",
        phase: w.phase,
        message: w.summary,
        runtime: w.runtime,
        handle: w.handle,
        prUrl: null,
        at: ago(w.lastReport),
      },
    ]),
  );
  const store = {
    ackedKeys: async () => [],
    openInboxItems: async () => items,
    openRuntimeHandles: async () => handles,
    pendingLaunches: async () => [],
    listJobs: async () => [],
    queueList: async () => [],
    getLease: async () => null,
    latestEvents: async () => events,
    lastAnsweredAt: async () => ({}),
  } as unknown as FleetStore;
  const entries = await readInbox(store, {
    project: PROJECT,
    coordinator: null,
    silentAfterMinutes: config.policy.silentAfterMinutes,
    notStartedMinutes: config.policy.notStartedMinutes,
    now,
  });
  // The watch returns on what it has not shown yet: the hand-back that just arrived.
  const shown = entries.map((e) => ({ ...e, new: e.kind === "hand-back" }));
  const inFlight = handles.map((h) => h.ticket);
  const watch = [
    ...renderEntries(PROJECT, shown),
    "New items are marked *.",
    rearm({ inFlight, open: shown.length, running: null, act: true }).line,
  ].join("\n");

  return [
    { command: "armada status", output: status.trimEnd() },
    { command: "armada watch", output: watch },
  ];
}

export const TRANSCRIPT_FILE = join(import.meta.dir, "..", "components", "landing", "transcript.ts");

export function transcriptModule(commands: TerminalCommand[]): string {
  return `// Written by \`bun run landing\` (scripts/landing.ts) from Armada's own code: do not edit.
import type { TerminalCommand } from "./terminal-types";

export const TRANSCRIPT: TerminalCommand[] = ${JSON.stringify(commands, null, 2)};
`;
}

export const SHARE_IMAGE_FILE = join(import.meta.dir, "..", "app", "landing", "opengraph-image.png");

/** A dart of the sky (components/landing/flock.ts): the mark's triangle stretched, at (x, y), heading `a`. */
function dart(x: number, y: number, a: number, len: number, color: string, opacity: number): string {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const w = len * 0.32;
  const p = [
    [x + c * len * 0.67, y + s * len * 0.67],
    [x - c * len * 0.33 - s * w, y - s * len * 0.33 + c * w],
    [x - c * len * 0.33 + s * w, y - s * len * 0.33 - c * w],
  ];
  return `<path d="M${p.map(([px, py]) => `${(px ?? 0).toFixed(1)} ${(py ?? 0).toFixed(1)}`).join(" L")}Z" fill="${color}" fill-opacity="${opacity}"/>`;
}

/** A squadron in a V, like the sky's. */
function squadron(x: number, y: number, a: number, n: number, len: number, color: string, opacity: number): string {
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    const row = Math.ceil(k / 2);
    const side = k % 2 ? -1 : 1;
    const back = -row * len * 2.9;
    const lat = side * row * len * 2;
    out.push(
      dart(
        x + back * Math.cos(a) - lat * Math.sin(a),
        y + back * Math.sin(a) + lat * Math.cos(a),
        a,
        len,
        color,
        opacity,
      ),
    );
  }
  return out.join("");
}

/** The share image: the hero's words, the mark and a sky of squadrons in the harnesses' colors. */
export function shareImageSvg(): string {
  const squadrons = [
    squadron(140, 520, -0.35, 5, 16, "#bb87fc", 0.85),
    squadron(1150, 470, -0.5, 4, 12, "#d97757", 0.7),
    squadron(980, 120, -0.2, 3, 10, "#10a37f", 0.6),
    squadron(700, 95, -0.15, 4, 8, "#bb87fc", 0.4),
    squadron(760, 600, -0.4, 3, 9, "#f0efec", 0.35),
    squadron(380, 70, -0.1, 3, 7, "#10a37f", 0.35),
  ].join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><radialGradient id="g" cx="0.78" cy="0.42" r="0.6"><stop offset="0" stop-color="#7ea6ff" stop-opacity="0.16"/><stop offset="1" stop-color="#7ea6ff" stop-opacity="0"/></radialGradient>
<radialGradient id="l" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#b6f15a" stop-opacity="0.35"/><stop offset="1" stop-color="#b6f15a" stop-opacity="0"/></radialGradient></defs>
<rect width="1200" height="630" fill="#09090b"/><rect width="1200" height="630" fill="url(#g)"/>
${squadrons}
<circle cx="928" cy="236" r="120" fill="url(#l)"/>
<g transform="translate(800 196) scale(8)">${markSvg()}</g>
<g transform="translate(72 66) scale(1.25)">${markSvg()}</g>
<text x="122" y="96" font-family="Geist" font-weight="600" font-size="30" letter-spacing="-0.6" fill="#f0efec">Armada</text>
<text font-family="Geist" font-weight="600" font-size="84" letter-spacing="-4.4" fill="#f0efec"><tspan x="68" y="300">Run a fleet of</tspan><tspan x="68" y="386">coding agents.</tspan><tspan x="68" y="472" fill="#a1a1a6">See every move.</tspan></text>
<text x="72" y="566" font-family="Geist Mono" font-size="22" fill="#6e6e73">armada.thevibecompany.co · open source</text>
</svg>`;
}

/** The share image, rendered with Geist from the font package the dashboard already loads. */
export async function shareImage(): Promise<Buffer> {
  const { Resvg } = await import("@resvg/resvg-js");
  const fonts = join(dirname(createRequire(import.meta.url).resolve("geist/package.json")), "dist", "fonts");
  const fontFiles = [
    join(fonts, "geist-sans", "Geist-SemiBold.ttf"),
    join(fonts, "geist-mono", "GeistMono-Regular.ttf"),
  ];
  for (const f of fontFiles) await readFile(f);
  const png = new Resvg(shareImageSvg(), { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "Geist" } });
  return png.render().asPng();
}

if (import.meta.main) {
  await writeFile(TRANSCRIPT_FILE, transcriptModule(await landingTranscript()));
  // In the repository's style, so a run that changes nothing leaves no diff.
  execFileSync("bunx", ["biome", "format", "--write", TRANSCRIPT_FILE], { stdio: "ignore" });
  console.log(`Wrote ${TRANSCRIPT_FILE}`);
  await writeFile(SHARE_IMAGE_FILE, await shareImage());
  console.log(`Wrote ${SHARE_IMAGE_FILE}`);
}
