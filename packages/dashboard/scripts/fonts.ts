// The dashboard's fonts (THE-889), cut from the `geist` package, never edited by hand:
//   bun run fonts      writes app/fonts/geist.ts and, next to it, the Latin cut
//                      and a copy of the full variable font of Geist and Geist Mono
// Every page preloads the Latin cut only. The full font follows through
// `unicode-range` for the characters it has outside the cut, so a page loads it
// only when it shows one, and never for a character Geist lacks.
// Run it after upgrading `geist` or changing the ranges or the features below:
// test/fonts.test.ts fails until then.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Google's WOFF2 encoder (wawoff2, WASM); it ships no types. */
const wawoff2 = require("wawoff2") as Record<"compress" | "decompress", (font: Uint8Array) => Promise<Uint8Array>>;

/** The characters of the Latin cut, inclusive ranges: whatever Geist has in them is kept. */
export const LATIN: [number, number][] = [
  [0x0000, 0x017f], // Basic Latin, Latin-1 Supplement, Latin Extended-A
  [0x2000, 0x206f], // General Punctuation: — – … › ’ “ ” •
  [0x20ac, 0x20ac], // €
  [0x2122, 0x2122], // ™
  [0x2190, 0x21ff], // Arrows: ↗ → ↑ ↓ ↵
  [0x2212, 0x2212], // − (minus)
];

/**
 * OpenType features the cut keeps besides the ones browsers apply by default
 * (HarfBuzz's default set: ccmp, locl, liga, calt, kern, mark, mkmk, rvrn…):
 * those globals.css asks for (`font-feature-settings: "zero", "ss01"`,
 * `font-variant-numeric: tabular-nums`).
 */
export const FEATURES = ["ss01", "zero", "tnum"];

export const FONTS_DIR = join(import.meta.dir, "..", "app", "fonts");
export const MODULE_FILE = join(FONTS_DIR, "geist.ts");

/** The fallback list of Geist Mono, as the `geist` package gives it (it sets no size-adjusted fallback). */
const MONO_FALLBACK = [
  "ui-monospace",
  "SFMono-Regular",
  "Roboto Mono",
  "Menlo",
  "Monaco",
  "Liberation Mono",
  "DejaVu Sans Mono",
  "Courier New",
  "monospace",
];

type Family = {
  /** The export of app/fonts/geist.ts for the Latin cut; the full font's adds `Full`. */
  name: string;
  /** The variable font in the `geist` package's dist/fonts. */
  source: string;
  /** Base name of the files written under app/fonts. */
  file: string;
  /** The CSS variable of the Latin cut; the full font's adds `-full`. */
  variable: string;
  mono: boolean;
};

export const FAMILIES: Family[] = [
  {
    name: "geist",
    source: "geist-sans/Geist-Variable.woff2",
    file: "geist",
    variable: "--font-geist-sans",
    mono: false,
  },
  {
    name: "geistMono",
    source: "geist-mono/GeistMono-Variable.woff2",
    file: "geist-mono",
    variable: "--font-geist-mono",
    mono: true,
  },
];

const tag = (name: string) => name.split("").reduce((value, c) => ((value << 8) | c.charCodeAt(0)) >>> 0, 0);

/** Where each table of a TrueType font starts, by tag. */
export function tables(font: Uint8Array): Map<string, number> {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const found = new Map<string, number>();
  for (let i = 0; i < view.getUint16(4); i++)
    found.set(String.fromCharCode(...font.subarray(12 + 16 * i, 16 + 16 * i)), view.getUint32(20 + 16 * i));
  return found;
}

/** The code points a TrueType font maps to a glyph (cmap formats 4 and 12). */
export function cmap(font: Uint8Array): number[] {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const base = tables(font).get("cmap");
  if (base === undefined) throw new Error("scripts/fonts.ts: the font has no cmap table");
  const points = new Set<number>();
  for (let i = 0; i < view.getUint16(base + 2); i++) {
    const at = base + view.getUint32(base + 8 + 8 * i);
    const format = view.getUint16(at);
    if (format === 12) {
      for (let g = 0; g < view.getUint32(at + 12); g++) {
        const group = at + 16 + 12 * g;
        for (let c = view.getUint32(group); c <= view.getUint32(group + 4); c++) points.add(c);
      }
    } else if (format === 4) {
      const segments = view.getUint16(at + 6) / 2;
      const ends = at + 14;
      const starts = ends + 2 * segments + 2;
      const deltas = starts + 2 * segments;
      const offsets = deltas + 2 * segments;
      for (let s = 0; s < segments; s++) {
        const start = view.getUint16(starts + 2 * s);
        const end = view.getUint16(ends + 2 * s);
        const offset = view.getUint16(offsets + 2 * s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          // Glyph 0 is "no glyph"; idDelta only shifts a non-zero glyph id read from the array.
          const glyph =
            offset === 0
              ? c + view.getInt16(deltas + 2 * s)
              : view.getUint16(offsets + 2 * s + offset + 2 * (c - start));
          if ((glyph & 0xffff) !== 0) points.add(c);
        }
      }
    }
  }
  return [...points].sort((a, b) => a - b);
}

/** Whether glyph 0, the box a character no font has is drawn as, keeps its outline (glyf and loca tables). */
export function notdefOutline(font: Uint8Array): boolean {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const at = tables(font);
  const loca = at.get("loca") ?? 0;
  const long = view.getInt16((at.get("head") ?? 0) + 50) === 1;
  const offset = (glyph: number) => (long ? view.getUint32(loca + 4 * glyph) : 2 * view.getUint16(loca + 2 * glyph));
  return offset(1) > offset(0);
}

/** The OpenType feature tags of a font's GSUB and GPOS tables. */
export function features(font: Uint8Array): string[] {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const found = new Set<string>();
  for (const [name, at] of tables(font)) {
    if (name !== "GSUB" && name !== "GPOS") continue;
    const list = at + view.getUint16(at + 6);
    for (let f = 0; f < view.getUint16(list); f++)
      found.add(String.fromCharCode(...font.subarray(list + 2 + 6 * f, list + 6 + 6 * f)));
  }
  return [...found].sort();
}

export const inLatin = (point: number) => LATIN.some(([from, to]) => point >= from && point <= to);

/** Sorted code points as inclusive ranges: each run of consecutive points becomes one. */
export function runs(points: number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const point of points) {
    const last = ranges.at(-1);
    if (last && last[1] === point - 1) last[1] = point;
    else ranges.push([point, point]);
  }
  return ranges;
}

/** A CSS `unicode-range` value. */
export function unicodeRange(ranges: [number, number][]): string {
  const hex = (n: number) => n.toString(16).toUpperCase();
  return ranges.map(([from, to]) => (from === to ? `U+${hex(from)}` : `U+${hex(from)}-${hex(to)}`)).join(", ");
}

type HbFunction =
  | "malloc"
  | "free"
  | "hb_blob_create"
  | "hb_blob_destroy"
  | "hb_blob_get_data"
  | "hb_blob_get_length"
  | "hb_face_create"
  | "hb_face_destroy"
  | "hb_face_reference_blob"
  | "hb_set_add"
  | "hb_subset_input_create_or_fail"
  | "hb_subset_input_destroy"
  | "hb_subset_input_set"
  | "hb_subset_input_get_flags"
  | "hb_subset_input_set_flags"
  | "hb_subset_or_fail";

/** HarfBuzz's subsetter (hb-subset, from harfbuzzjs), a WASM module with no imports. */
async function subsetter() {
  const wasm = await readFile(require.resolve("harfbuzzjs/dist/harfbuzz-subset.wasm"));
  const { instance } = await WebAssembly.instantiate(wasm);
  const hb = instance.exports as Record<HbFunction, (...args: number[]) => number> & { memory: WebAssembly.Memory };
  const SETS_UNICODE = 1;
  const SETS_LAYOUT_FEATURE_TAG = 6;
  // Keeps the box a missing character is drawn as where no installed font has it either (⌘ on Linux).
  const FLAGS_NOTDEF_OUTLINE = 0x40;
  return (font: Uint8Array, points: number[], keep: string[]): Uint8Array => {
    const at = hb.malloc(font.byteLength);
    new Uint8Array(hb.memory.buffer).set(font, at);
    const blob = hb.hb_blob_create(at, font.byteLength, 2 /* writable */, 0, 0);
    const face = hb.hb_face_create(blob, 0);
    hb.hb_blob_destroy(blob);
    const input = hb.hb_subset_input_create_or_fail();
    hb.hb_subset_input_set_flags(input, hb.hb_subset_input_get_flags(input) | FLAGS_NOTDEF_OUTLINE);
    const unicodes = hb.hb_subset_input_set(input, SETS_UNICODE);
    for (const point of points) hb.hb_set_add(unicodes, point);
    const layout = hb.hb_subset_input_set(input, SETS_LAYOUT_FEATURE_TAG);
    for (const feature of keep) hb.hb_set_add(layout, tag(feature));
    const subset = hb.hb_subset_or_fail(face, input);
    hb.hb_subset_input_destroy(input);
    if (subset === 0) throw new Error("scripts/fonts.ts: HarfBuzz could not subset the font");
    const out = hb.hb_face_reference_blob(subset);
    const data = hb.hb_blob_get_data(out, 0);
    const result = new Uint8Array(hb.memory.buffer, data, hb.hb_blob_get_length(out)).slice();
    hb.hb_blob_destroy(out);
    hb.hb_face_destroy(subset);
    hb.hb_face_destroy(face);
    hb.free(at);
    return result;
  };
}

export type FontFile = { file: string; data: Uint8Array };

export type Cut = {
  family: Family;
  /** The package's full font, as TrueType, and its code points. */
  font: Uint8Array;
  full: number[];
  /** The Latin cut, as TrueType, to read its tables. */
  latinFont: Uint8Array;
  files: FontFile[];
};

/** Each family's Latin cut and full font, as `bun run fonts` writes them. */
export async function cuts(): Promise<Cut[]> {
  const fonts = join(dirname(require.resolve("geist/package.json")), "dist", "fonts");
  const subset = await subsetter();
  const result: Cut[] = [];
  for (const family of FAMILIES) {
    const woff2 = new Uint8Array(await readFile(join(fonts, family.source)));
    // wawoff2 answers with a view of its own memory, which its next call overwrites: copy each answer.
    const font = (await wawoff2.decompress(woff2)).slice();
    const full = cmap(font);
    const latinFont = subset(font, full.filter(inLatin), FEATURES);
    result.push({
      family,
      font,
      full,
      latinFont,
      files: [
        { file: `${family.file}-latin.woff2`, data: (await wawoff2.compress(latinFont)).slice() },
        { file: `${family.file}.woff2`, data: woff2 },
      ],
    });
  }
  return result;
}

/** app/fonts/geist.ts: next/font takes literals only, so the ranges are written into it. */
export function fontsModule(families: Cut[]): string {
  const calls = families.flatMap(({ family, full }) => {
    const fallback = family.mono
      ? `  adjustFontFallback: false,\n  fallback: [\n${MONO_FALLBACK.map((f) => `    "${f}",`).join("\n")}\n  ],\n`
      : "";
    return [
      `export const ${family.name} = localFont({
  src: "./${family.file}-latin.woff2",
  variable: "${family.variable}",
  weight: "100 900",
${fallback}  declarations: [{ prop: "unicode-range", value: "${unicodeRange(LATIN)}" }],
});`,
      `export const ${family.name}Full = localFont({
  src: "./${family.file}.woff2",
  variable: "${family.variable}-full",
  weight: "100 900",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "${unicodeRange(runs(full.filter((p) => !inLatin(p))))}",
    },
  ],
});`,
    ];
  });
  return `// Written by \`bun run fonts\` (scripts/fonts.ts) from the \`geist\` package: do not edit.
// Each Latin cut is preloaded on every page; each full font is listed first in
// --font-sans and --font-mono (app/globals.css) and loads only for a character in its range.
import localFont from "next/font/local";

${calls.join("\n\n")}
`;
}

if (import.meta.main) {
  const families = await cuts();
  for (const { files } of families)
    for (const { file, data } of files) {
      await writeFile(join(FONTS_DIR, file), data);
      console.log(`Wrote app/fonts/${file} (${data.byteLength} bytes)`);
    }
  await writeFile(MODULE_FILE, fontsModule(families));
  console.log("Wrote app/fonts/geist.ts");
}
