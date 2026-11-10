import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { encryptSecret } from "@armada/core";
import { run } from "../../../packages/cli/src/run.ts";
import { landingTranscript } from "../scripts/landing-transcript.ts";
import { INSTALL, SETUP, STORY } from "../src/components/landing/content.ts";
import { BREAK_AT, createSky, INTRO, LIME, step } from "../src/components/landing/flock.ts";
import { TRANSCRIPT } from "../src/components/landing/transcript.ts";

// The public landing, restored from armada-v1-final (#564), its story retold by
// #587. What it says that the code decides is held here to that code (the CLI's
// help and output, the token's lifetime, the cipher, the README); and: it reads
// no session or data, it never holds the scroll, and the sky moves the same at
// any frame rate.

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

/**
 * `armada --help`, one usage block per line that starts `  armada `: the commands it documents (`golden <sub>`
 * for goldens, the first word otherwise) and, for each, the text of its blocks, where its flags are.
 */
async function help(): Promise<Map<string, string>> {
  let text = "";
  expect(await run(["--help"], { out: (chunk) => (text += chunk), err: () => undefined })).toBe(0);
  const usage = new Map<string, string>();
  for (const block of text.split(/\n(?= {2}armada )/)) {
    const [, first = "", second = ""] = block.match(/^ {2}armada ([a-z][a-z|-]*)(?: ([a-z][a-z|-]*))?/) ?? [];
    for (const word of first.split("|").filter(Boolean))
      for (const sub of word === "golden" ? second.split("|") : [""]) {
        const name = sub ? `golden ${sub}` : word;
        usage.set(name, `${usage.get(name) ?? ""}${block}\n`);
      }
  }
  return usage;
}

describe("what the landing says", () => {
  test("shows only commands armada --help documents, each with flags its own usage lists", async () => {
    const usage = await help();
    expect(usage.size).toBeGreaterThan(10);
    const shown = [...Object.values(STORY), ...SETUP.map((s) => s.command)].filter((c) => c.startsWith("armada "));
    expect(shown.length).toBeGreaterThan(5);
    const unknown = shown.flatMap((line) => {
      const [, first = "", second = ""] = line.split(" ");
      const command = first === "golden" ? `golden ${second}` : first;
      const own = usage.get(command);
      if (own === undefined) return [`${line}: no command ${command}`];
      const flags = line.match(/(?<=\s)--[a-z][a-z-]*/g) ?? [];
      return flags
        .filter((flag) => !new RegExp(`${flag}(?![a-z-])`).test(own))
        .map((flag) => `${line}: no flag ${flag}`);
    });
    expect(unknown).toEqual([]);
  });

  test("installs the README's package and does not promise a fresh GitHub token lifetime", async () => {
    expect(read(join(REPO, "README.md"))).toContain(INSTALL.replace(" -g ", " --global "));
    expect(SETUP[0]?.command).toBe(INSTALL);
    const launch = (await landingTranscript()).find((entry) => entry.command.startsWith("armada launch "));
    expect(launch?.output).toContain("launch token expires at 2026-11-09T17:30:00.000Z (~480 minutes remaining)");
    expect(launch?.output).toContain("armada github refresh");
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
    // The story's chapters are part of what the page reaches.
    expect(rel).toContain("src/components/landing/Figures.tsx");
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

describe("the scroll (THE-1049)", () => {
  test("is never held: no sticky block, none taller than the screen, no scroll or wheel listener", () => {
    const own = modules.filter((f) => /\/(components|app)\/landing\//.test(f));
    expect(own.map((f) => relative(ROOT, f))).toContain("src/components/landing/Story.tsx");
    const css = read(join(ROOT, "src/app/landing/landing.css"));
    expect(css).not.toMatch(/position:\s*sticky/);
    const tall = [...css.matchAll(/(\d+(?:\.\d+)?)[sdl]?vh\b/g)].filter(([, n]) => Number(n) > 100).map(([m]) => m);
    expect(tall).toEqual([]);
    const listens = /addEventListener\(\s*"(scroll|wheel|touchmove|mousewheel)"|\bon(Scroll|Wheel|TouchMove)\b/;
    expect(own.filter((f) => listens.test(read(f))).map((f) => relative(ROOT, f))).toEqual([]);
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
