import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { encryptSecret } from "@armada/core";
import { run } from "../../../packages/cli/src/run.ts";
import { landingTranscript } from "../scripts/landing-transcript.ts";
import { COMMANDS, GITHUB_TOKEN_HOURS, INSTALL, SETUP } from "../src/components/landing/content.ts";
import { BREAK_AT, createSky, INTRO, LIME, step } from "../src/components/landing/flock.ts";
import { tabStep } from "../src/components/landing/keyboard.ts";
import { ASKED, HANDED_BACK, rowsAt, summary } from "../src/components/landing/replica-script.ts";
import { TRANSCRIPT } from "../src/components/landing/transcript.ts";

// The public landing, restored from armada-v1-final (#564) with its words
// brought to Armada v2. What it says that the code decides is held here to that
// code (the CLI's help and output, the token's lifetime, the cipher, the README);
// and, as in v1: it reads no session or data, the method never holds the scroll,
// the sky moves the same at any frame rate, and the v1 replay plays its beats.

const ROOT = resolve(import.meta.dir, "..");
const REPO = resolve(ROOT, "../..");
const read = (path: string) => readFileSync(path, "utf8");

/** Every local module a file loads: types are erased. */
function reach(start: string, seen = new Set<string>()): Set<string> {
  if (seen.has(start)) return seen;
  seen.add(start);
  const source = read(start);
  const specs = [
    ...source.matchAll(/^(?:import|export)\s+(?!type\s)[^;]*?(?:from\s+)?"((?:@\/|\.)[^"]+)"/gms),
    ...source.matchAll(/\bimport\("((?:@\/|\.)[^"]+)"\)/g),
  ];
  for (const [, spec] of specs) {
    const base = spec?.startsWith("@/") ? join(ROOT, "src", spec.slice(2)) : resolve(dirname(start), spec ?? "");
    const file = [base, `${base}.tsx`, `${base}.ts`, join(base, "index.ts")].find(
      (f) => existsSync(f) && statSync(f).isFile(),
    );
    if (file && /\.tsx?$/.test(file)) reach(file, seen);
  }
  return seen;
}

const PAGE = join(ROOT, "src/app/landing/page.tsx");
const modules = [...reach(PAGE)];

/** The commands `armada --help` documents: `golden <sub>` for goldens, the first word otherwise. */
async function helpCommands(): Promise<Set<string>> {
  let text = "";
  expect(await run(["--help"], { out: (chunk) => (text += chunk), err: () => undefined })).toBe(0);
  const names = new Set<string>();
  for (const [, first = "", second = ""] of text.matchAll(/^ {2}armada ([a-z][a-z|-]*)(?: ([a-z][a-z|-]*))?/gm))
    for (const word of first.split("|"))
      for (const sub of word === "golden" ? second.split("|") : [""]) names.add(sub ? `golden ${sub}` : word);
  return names;
}

describe("what the landing says", () => {
  test("lists exactly the commands armada --help documents, each once", async () => {
    const help = await helpCommands();
    expect(help.size).toBeGreaterThan(10);
    const listed = COMMANDS.map((c) => c.name);
    // Never a command the CLI no longer has; a new one (say `golden remove`) goes into content.ts's COMMANDS.
    expect({
      notInHelp: listed.filter((name) => !help.has(name)),
      notOnLanding: [...help].filter((name) => !listed.includes(name)),
    }).toEqual({ notInHelp: [], notOnLanding: [] });
    expect(new Set(listed).size).toBe(COMMANDS.length);
    for (const { command } of SETUP.slice(1)) expect(help.has(command.split(" ")[1] ?? "")).toBe(true);
  });

  test("installs the README's package and gives the sandbox's GitHub token the lifetime the CLI states", () => {
    expect(read(join(REPO, "README.md"))).toContain(INSTALL.replace(" -g ", " --global "));
    expect(SETUP[0]?.command).toBe(INSTALL);
    // GitHub sets the user token's lifetime; the CLI tells it at every launch, and the landing must say the same.
    expect(read(join(REPO, "packages/cli/src/run.ts"))).toContain(`token valid for ${GITHUB_TOKEN_HOURS} hours`);
  });

  test("seals keys the way it says: AES-GCM under a 256-bit key only", async () => {
    const key = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");
    await expect(encryptSecret("k", key(16))).rejects.toThrow();
    // A 12-byte IV, the ciphertext and a 16-byte GCM tag.
    expect((await encryptSecret("k", key(32))).length).toBe(12 + 1 + 16);
  });

  test("replays the session the CLI's own code prints (bun apps/dashboard/scripts/landing-transcript.ts)", async () => {
    expect(TRANSCRIPT).toEqual(await landingTranscript());
  });
});

describe("the landing page", () => {
  test("reads no cookie, session, database, provider or server, and fetches nothing", () => {
    const rel = modules.map((f) => relative(ROOT, f));
    // The lazily loaded replica is part of what the page reaches.
    expect(rel).toContain("src/components/landing/Replica.tsx");
    const offenders = modules
      .filter((f) =>
        /next\/headers|cookies\(\)|\bfetch\(|@\/lib\/(supabase|control|env|data|gateway|credentials)|@armada\/core\/server|@supabase\//.test(
          read(f),
        ),
      )
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});

describe("the method (THE-1049)", () => {
  test("never holds the scroll: no sticky stage, no block taller than the screen, no scroll or wheel listener", () => {
    const own = modules.filter((f) => /\/(components|app)\/landing\//.test(f));
    expect(own.map((f) => relative(ROOT, f))).toContain("src/components/landing/MethodSteps.tsx");
    const css = read(join(ROOT, "src/app/landing/landing.css"));
    expect(css).not.toMatch(/position:\s*sticky/);
    const tall = [...css.matchAll(/(\d+(?:\.\d+)?)[sdl]?vh\b/g)].filter(([, n]) => Number(n) > 100).map(([m]) => m);
    expect(tall).toEqual([]);
    const listens = /addEventListener\(\s*"(scroll|wheel|touchmove|mousewheel)"|\bon(Scroll|Wheel|TouchMove)\b/;
    expect(own.filter((f) => listens.test(read(f))).map((f) => relative(ROOT, f))).toEqual([]);
  });

  test("arrow keys wrap around the steps; Home and End go to the ends; any other key is the page's", () => {
    for (const [key, at, expected] of [
      ["ArrowRight", 0, 1],
      ["ArrowDown", 3, 4],
      ["ArrowRight", 4, 0],
      ["ArrowLeft", 0, 4],
      ["ArrowUp", 2, 1],
      ["Home", 3, 0],
      ["End", 1, 4],
      ["Enter", 2, null],
    ] as const)
      expect(tabStep(key, at, 5)).toBe(expected);
  });
});

describe("the replica of the overview (THE-931)", () => {
  const beats = { delivered: 0.65, handedBack: 1.4 };
  const groupOf = (stage: Parameters<typeof rowsAt>[0], id: string) => rowsAt(stage, beats).find((r) => r.id === id);

  test("opens with WID-15 blocked on its question and WID-18 still in progress", () => {
    expect(groupOf("opening", ASKED)?.group).toBe("blocked");
    expect(groupOf("opening", HANDED_BACK)?.group).toBe("running");
    expect(summary(rowsAt("opening", beats), "opening").headline).toBe(
      "4 agents blocked, 3 waiting for your decision.",
    );
  });

  test("ends on WID-18's merge waiting for the owner, after it was ready to merge, and WID-15 back at work", () => {
    expect(groupOf("delivered", ASKED)).toMatchObject({ group: "running", at: beats.delivered });
    expect(groupOf("handed-back", HANDED_BACK)).toMatchObject({ group: "ready", step: 4 });
    expect(groupOf("to-validate", HANDED_BACK)).toMatchObject({
      group: "you",
      reason: "Merge to approve · #44 green",
      step: 4,
      at: beats.handedBack,
    });
    const end = summary(rowsAt("to-validate", beats), "to-validate");
    expect(end.headline).toBe("3 agents blocked, 4 waiting for your decision.");
    expect(end.subline).toBe(
      "11 agents in flight across 3 projects · 3 moving on their own · 1 ready to merge · 5 merged today",
    );
    expect(end.validations).toBe(3);
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
