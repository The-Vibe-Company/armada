import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  cmap,
  cuts,
  FONTS_DIR,
  features,
  fontsModule,
  inLatin,
  MODULE_FILE,
  notdefOutline,
  tables,
} from "../scripts/fonts";
import { renderModule } from "./render-module";

// Every page preloads the Latin cut of Geist and Geist Mono only (THE-889): the
// cut must hold every character the app writes, and the full font must follow
// for any other character Geist has.

const ROOT = resolve(import.meta.dir, "..");
const families = await cuts();

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && ext.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("the dashboard's fonts (THE-889)", () => {
  test("are the ones `bun run fonts` cuts from the geist package today", () => {
    for (const { files } of families)
      for (const { file, data } of files)
        expect({ file, same: Buffer.compare(readFileSync(join(FONTS_DIR, file)), data) === 0 }).toEqual({
          file,
          same: true,
        });
    expect(readFileSync(MODULE_FILE, "utf8")).toBe(fontsModule(families));
  });

  test("the Latin cut keeps every character Geist has in its ranges, the weight axis, the missing-glyph box and the features the CSS asks for", () => {
    const css = files(join(ROOT, "app"), /\.css$/)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const asked = new Set<string>();
    for (const [, settings] of css.matchAll(/font-feature-settings:\s*([^;]+);/g))
      for (const [, feature] of (settings ?? "").matchAll(/"(\w{4})"/g)) asked.add(feature ?? "");
    const NUMERIC: Record<string, string> = { "tabular-nums": "tnum", "slashed-zero": "zero", "oldstyle-nums": "onum" };
    for (const [, value] of css.matchAll(/font-variant-numeric:\s*([^;]+);/g))
      for (const word of (value ?? "").split(/\s+/)) if (NUMERIC[word]) asked.add(NUMERIC[word]);
    expect(asked.size).toBeGreaterThan(0);

    for (const { family, font, full, latinFont } of families) {
      const kept = new Set(features(latinFont));
      expect({
        family: family.name,
        chars: cmap(latinFont),
        lost: features(font).filter((feature) => asked.has(feature) && !kept.has(feature)),
        weightAxis: tables(latinFont).has("fvar"),
        missingGlyphBox: notdefOutline(latinFont),
      }).toEqual({
        family: family.name,
        chars: full.filter(inLatin),
        lost: [],
        weightAxis: true,
        missingGlyphBox: notdefOutline(font),
      });
    }
  });

  test("every character the app writes that Geist has is in the Latin cut", () => {
    const geist = new Set(families.flatMap(({ full }) => full));
    const sources = [
      ...["app", "components", "lib"].flatMap((dir) => files(join(ROOT, dir), /\.(tsx?|css|json)$/)),
      ...files(resolve(ROOT, "../core/src"), /\.ts$/),
    ];
    const outside = new Map<string, string>();
    for (const file of sources)
      for (const char of readFileSync(file, "utf8")) {
        const point = char.codePointAt(0) ?? 0;
        if (point > 0x7e && geist.has(point) && !inLatin(point)) outside.set(char, relative(ROOT, file));
      }
    expect(Object.fromEntries(outside)).toEqual({});
  });

  test("every page lists each full font before its Latin cut", () => {
    const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
    expect(css).toContain("--font-sans: var(--font-geist-sans-full), var(--font-geist-sans),");
    expect(css).toContain("--font-mono: var(--font-geist-mono-full), var(--font-geist-mono),");
    const layout = renderModule(join(ROOT, "app/layout.tsx"), {
      "./fonts/geist": {
        geist: { variable: "sans-latin" },
        geistFull: { variable: "sans-full" },
        geistMono: { variable: "mono-latin" },
        geistMonoFull: { variable: "mono-full" },
      },
      "./globals.css": {},
      "@vercel/speed-insights/next": { SpeedInsights: () => null },
    }).default as ComponentType<{ children?: string }>;
    const html = renderToStaticMarkup(createElement(layout, null, "Font registration"));
    expect(
      html
        .match(/<html[^>]*class="([^"]+)"/)?.[1]
        ?.split(/\s+/)
        .sort(),
    ).toEqual(["mono-full", "mono-latin", "sans-full", "sans-latin"]);
  });
});
