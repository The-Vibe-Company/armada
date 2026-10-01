import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { CIPHER, COMMANDS, LAUNCH_TOKEN_HOURS, SETUP } from "../components/landing/content";
import { BREAK_AT, createSky, INTRO, LIME, step } from "../components/landing/flock";
import { TRANSCRIPT } from "../components/landing/transcript";
import { LAUNCH_TOKEN_MS } from "../lib/workers";
import { landingTranscript, SHARE_IMAGE_FILE, shareImage } from "../scripts/landing";

// The landing (THE-887) says only what Armada does: each claim it makes is
// held here to the code that decides it, and the page reads no fleet data.

const ROOT = resolve(import.meta.dir, "..");
const REPO = resolve(ROOT, "../..");
const read = (path: string) => readFileSync(path, "utf8");

describe("what the landing says", () => {
  test("lists every command of armada --help, in its order", () => {
    const cli = read(join(REPO, "packages/cli/src/cli.ts"));
    const block = cli.slice(cli.indexOf("const COMMAND_HELP"), cli.indexOf("\n};", cli.indexOf("const COMMAND_HELP")));
    const help = [...block.matchAll(/^ {2}"?([a-z-]+)"?: `/gm)].map((m) => m[1]);
    expect(help.length).toBeGreaterThan(10);
    expect(COMMANDS.map((c) => c.name)).toEqual(help as string[]);
  });

  test("gives the launch token's lifetime and the vault's cipher as the code sets them", () => {
    expect(LAUNCH_TOKEN_HOURS * 60 * 60 * 1000).toBe(LAUNCH_TOKEN_MS);
    expect(read(join(ROOT, "lib/vault.ts"))).toContain(`createCipheriv("${CIPHER.toLowerCase()}"`);
  });

  test("installs with the README's commands", () => {
    const readme = read(join(REPO, "README.md"));
    for (const { command } of SETUP) expect(readme).toContain(command);
  });

  test("replays the session Armada's own code prints (bun run landing)", async () => {
    expect(TRANSCRIPT).toEqual(await landingTranscript());
  });

  test("shares the image bun run landing draws", async () => {
    expect((await shareImage()).equals(readFileSync(SHARE_IMAGE_FILE))).toBe(true);
  });
});

/**
 * Every local module a file loads: types are erased, and a server action is
 * only a reference in a client component.
 */
function reach(start: string, seen = new Set<string>()): Set<string> {
  if (seen.has(start)) return seen;
  seen.add(start);
  const source = read(start);
  if (/^["']use server["']/m.test(source)) return seen;
  const specs = [
    ...source.matchAll(/^(?:import|export)\s+(?!type\s)[^;]*?(?:from\s+)?"((?:@\/|\.)[^"]+)"/gms),
    ...source.matchAll(/\bimport\("((?:@\/|\.)[^"]+)"\)/g),
  ];
  for (const [, spec] of specs) {
    const base = spec?.startsWith("@/") ? join(ROOT, spec.slice(2)) : resolve(dirname(start), spec ?? "");
    const file = [base, `${base}.tsx`, `${base}.ts`, join(base, "index.ts")].find(
      (f) => existsSync(f) && statSync(f).isFile(),
    );
    if (file && /\.tsx?$/.test(file)) reach(file, seen);
  }
  return seen;
}

describe("the landing page", () => {
  const page = join(ROOT, "app/landing/page.tsx");
  // The page, and the demo world's overview its replica fetches.
  const modules = [...reach(join(ROOT, "app/landing/fleet.json/route.ts"), reach(page))];

  test("is prerendered once, at build, with the overview its replica plays", () => {
    expect(read(page)).toContain('export const dynamic = "force-static"');
    expect(read(join(ROOT, "app/landing/fleet.json/route.ts"))).toContain('export const dynamic = "force-static"');
  });

  test("reads no cookie, database, session, Linear or GitHub", () => {
    const rel = modules.map((f) => relative(ROOT, f));
    expect(rel).toContain("components/Fleet.tsx");
    const data =
      /^lib\/(server|db|app-db|access|fleet-data|fleet-store|snapshots|accounts|accounts-server|broker|github-app)\.ts$/;
    expect(rel.filter((f) => data.test(f))).toEqual([]);
    const offenders = modules
      .filter((f) => !/^["']use server["']/m.test(read(f)))
      // The landing's own static files (its replica's overview) are fine to fetch.
      .filter((f) => /next\/headers|\bfetch\((?!"\/landing\/)|cookies\(\)/.test(read(f)))
      .map((f) => relative(ROOT, f));
    // They read the server only in the shell: its poll (FleetProvider), its visit beacon (VisitProvider,
    // THE-894) and the summary it announces, and the timeline's history when none is given. The replica
    // runs in ShowcaseProvider, which gives the history, never polls and has no visit.
    expect(offenders.sort()).toEqual([
      "components/SinceAway.tsx",
      "components/shell/context.tsx",
      "components/shell/visit.tsx",
      "components/timeline/Timeline.tsx",
    ]);
  });
});

describe("the hero's sky", () => {
  const sky = () => createSky(1440, 900, { anchor: { x: 1060, y: 380 }, markScale: 5 });
  const run = (s: ReturnType<typeof sky>, seconds: number, hz: number) => {
    for (let k = 0; k < Math.round(seconds * hz); k++) step(s, 1 / hz);
  };
  const flagship = (s: ReturnType<typeof sky>) => s.squadrons.flatMap((q) => q.ships).find((sh) => sh.color === LIME);

  test("flies the mark in, holds it on its anchor pointing up, then breaks it into five ships", () => {
    const s = sky();
    run(s, INTRO.arrive + INTRO.hold / 2, 60);
    const lead = flagship(s);
    expect(Math.hypot((lead?.x ?? 0) - 1060, (lead?.y ?? 0) - 380)).toBeLessThan(4);
    expect(lead?.angle).toBeCloseTo(-Math.PI / 2, 2);
    run(s, BREAK_AT - s.time + 0.5, 60);
    expect(s.intro).toBeNull();
    // The mark's five (its lime leader, its fainter wings) each fly on their own.
    const mark = s.squadrons.filter((q) => q.ships.some((sh) => sh.color === LIME || sh.tone !== 1));
    expect(mark.map((q) => q.ships.length)).toEqual([1, 1, 1, 1, 1]);
  });

  test("moves the same on a 60 Hz and a 120 Hz screen", () => {
    const at60 = sky();
    const at120 = sky();
    run(at60, 4, 60);
    run(at120, 4, 120);
    const a = flagship(at60);
    const b = flagship(at120);
    expect(Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0))).toBeLessThan(6);
    expect(at120.squadrons.length).toBe(at60.squadrons.length);
  });
});
