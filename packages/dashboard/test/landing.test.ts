import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { run } from "../../cli/src/cli.ts";
import { CIPHER, COMMANDS, LAUNCH_TOKEN_HOURS, SETUP } from "../components/landing/content";
import { BREAK_AT, createSky, INTRO, LIME, step } from "../components/landing/flock";
import { ASKED, delivered, HANDED_BACK, handedBack, opening, toValidate } from "../components/landing/replica-script";
import { TRANSCRIPT } from "../components/landing/transcript";
import { checksOf, overviewItems, ownerChecks } from "../lib/coordinator-view";
import { demoOverview } from "../lib/demo/overview";
import { agentState } from "../lib/fleet-view";
import { LAUNCH_TOKEN_MS } from "../lib/workers";
import { landingTranscript, SHARE_IMAGE_FILE, shareImage } from "../scripts/landing";

// The landing (THE-887) says only what Armada does: each claim it makes is
// held here to the code that decides it, and the page reads no fleet data.

const ROOT = resolve(import.meta.dir, "..");
const REPO = resolve(ROOT, "../..");
const read = (path: string) => readFileSync(path, "utf8");

describe("what the landing says", () => {
  test("lists every command of armada --help, in its order", async () => {
    let text = "";
    expect(
      await run(["--help"], {
        cwd: REPO,
        env: {},
        readFile: async () => null,
        ghToken: () => null,
        stdout: (chunk) => {
          text += chunk;
        },
        stderr: () => {},
      }),
    ).toBe(0);
    const help = [...text.matchAll(/^ {2}([a-z][a-z-]*)(?: |$)/gm)].map((match) => match[1] ?? "");
    // Help can include several synopsis lines per command; retain its public order once each.
    const commands = [...new Set(help)];
    expect(commands.length).toBeGreaterThan(10);
    expect(COMMANDS.map((command) => command.name)).toEqual(commands);
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
    expect(rel).toContain("components/screens/OverviewScreen.tsx");
    const data =
      /^lib\/(server|db|app-db|access|fleet-data|fleet-store|snapshots|accounts|accounts-server|broker|github-app)\.ts$/;
    expect(rel.filter((f) => data.test(f))).toEqual([]);
    const offenders = modules
      .filter((f) => !/^["']use server["']/m.test(read(f)))
      // The landing's own static files (its replica's overview) are fine to fetch.
      .filter((f) => /next\/headers|\bfetch\((?!"\/landing\/)|cookies\(\)/.test(read(f)))
      .map((f) => relative(ROOT, f));
    // They read the server only in the shell's poll (FleetProvider), and in the overview's preview pane (a
    // session's history). The replica runs in ShowcaseProvider, which never polls, and shows the list alone.
    expect(offenders.sort()).toEqual(["components/screens/use-activity.ts", "components/shell/context.tsx"]);
  });
});

describe("the method (THE-1049)", () => {
  test("never holds the scroll: no sticky stage, no block taller than the screen, no scroll or wheel listener", () => {
    const own = [...reach(join(ROOT, "app/landing/page.tsx"))].filter((f) => /\/(components|app)\/landing\//.test(f));
    expect(own.map((f) => relative(ROOT, f))).toContain("components/landing/MethodSteps.tsx");
    const css = read(join(ROOT, "app/landing/landing.css"));
    expect(css).not.toMatch(/position:\s*sticky/);
    const tall = [...css.matchAll(/(\d+(?:\.\d+)?)[sdl]?vh\b/g)].filter(([, n]) => Number(n) > 100).map(([m]) => m);
    expect(tall).toEqual([]);
    const listens = /addEventListener\(\s*"(scroll|wheel|touchmove|mousewheel)"|\bon(Scroll|Wheel|TouchMove)\b/;
    expect(own.filter((f) => listens.test(read(f))).map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe("the replica of the overview (THE-931)", () => {
  const base = demoOverview(new Date("2026-10-01T13:42:00Z"));
  const at = Date.parse(base.generatedAt);
  const toCheck = (o: typeof base) => {
    const checks = ownerChecks(o);
    return o.rows.filter((r) => checksOf(checks, r).length).map((r) => r.id);
  };

  test("opens on the seeded demo: its sessions to validate, WID-15 asking, WID-18 still shipping", () => {
    const o = opening(base);
    expect(toCheck(o).sort()).toEqual(["GAD-9", "THE-862"]);
    const asked = o.rows.find((r) => r.id === ASKED);
    expect(asked && agentState(asked).reason).toBe("question");
    expect(o.rows.find((r) => r.id === HANDED_BACK)?.phase).toBe("shipping");
  });

  test("ends on WID-18 waiting for the owner's decision, WID-15 back at work", () => {
    const o = opening(base);
    const end = toValidate(handedBack(delivered(o, at + 1), base, at + 2), base, at + 3);
    expect(end.rows.find((r) => r.id === ASKED)).toMatchObject({ phase: "implementing", question: null });
    expect(end.rows.find((r) => r.id === HANDED_BACK)?.phase).toBe("ready-to-merge");
    expect(toCheck(end).sort()).toEqual(["GAD-9", "THE-862", HANDED_BACK]);
    // On the overview (THE-1020): WID-18 waits for the owner's decision, a merge to approve; WID-15 runs again.
    const items = overviewItems(end, { now: at + 3, zone: "UTC" });
    const of = (id: string) => items.find((i) => i.id === id);
    expect(of(HANDED_BACK)).toMatchObject({ group: "you", reason: { kind: "merge" }, step: 4 });
    expect(of(ASKED)?.group).toBe("running");
    // Before the merge was asked, the hand-back was ready to merge.
    const before = overviewItems(handedBack(delivered(o, at + 1), base, at + 2), { now: at + 2, zone: "UTC" });
    expect(before.find((i) => i.id === HANDED_BACK)?.group).toBe("ready");
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
