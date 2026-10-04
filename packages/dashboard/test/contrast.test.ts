import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// WCAG 2.2 AA on the tokens (THE-891): text reads at 4.5:1 at least and a
// mark (a dot, a ring, a bar) at 3:1, on every surface it is drawn on. The
// axe run (scripts/a11y.ts) checks the pages; this keeps a new token, or a
// darker surface, from failing them all at once.

const css = readFileSync(join(resolve(import.meta.dir, ".."), "app/globals.css"), "utf8");
const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
const tokens = new Map([...root.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]));

type Rgba = [number, number, number, number];

function color(name: string): Rgba {
  const value = tokens.get(name);
  if (!value) throw new Error(`no token --${name}`);
  const hex = value.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex) return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgba = value.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
  if (rgba) return rgba.slice(1).map(Number) as Rgba;
  throw new Error(`--${name} is not a color this test reads: ${value}`);
}

/** A translucent fill over an opaque surface, as the browser composes it. */
const over = (top: Rgba, under: Rgba): Rgba =>
  [0, 1, 2].map((i) => (top[i] ?? 0) * top[3] + (under[i] ?? 0) * (1 - top[3])).concat(1) as Rgba;

const luminance = ([r, g, b]: Rgba) => {
  const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

const ratio = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * The planes (THE-899, THE-1020): the sidebar (--side), the page (--bg,
 * --surface), bands, instruments (--card, --panel-3) and wells (--sunken,
 * --code); then the fills
 * drawn over the sky, the deck and an instrument (a tab bar, a field, a stat
 * chip, the current entry), and the menus' and toasts' glass over the sky.
 */
const SURFACES = ["side", "bg", "surface", "card", "sunken", "code", "band", "panel-3"];
const FILLS = ["hover", "fill", "fill-2"];
const backgrounds = [
  ...SURFACES.map((s) => ({ name: s, rgb: color(s) })),
  ...FILLS.flatMap((f) =>
    ["bg", "surface", "card"].map((s) => ({ name: `${f} over ${s}`, rgb: over(color(f), color(s)) })),
  ),
  ...["overlay", "overlay-glass"].map((o) => ({ name: `${o} over bg`, rgb: over(color(o), color("bg")) })),
];

/** Every token text is written in. --raised (a selected tab, an avatar) takes --text and --text-2 only. */
const TEXT = [
  "text",
  "text-soft",
  "text-2",
  "text-3",
  // The states (design/dashboard-v7).
  ...["red", "amber", "blue", "green"],
];
/** Marks: the focus ring. (A step bar is decorative: its step is in words beside it.) */
const MARKS = ["blue"];

const failures = (names: string[], min: number, on: typeof backgrounds) =>
  names.flatMap((n) =>
    on
      .map((b) => ({ pair: `--${n} on ${b.name}`, ratio: Math.round(ratio(color(n), b.rgb) * 100) / 100 }))
      .filter((p) => p.ratio < min),
  );

describe("the dark theme's tokens", () => {
  test("text reads at 4.5:1 on every surface and fill", () => {
    expect(failures(TEXT, 4.5, backgrounds)).toEqual([]);
  });

  test("a state's text reads on its own 13% fill (a selected chip, an error)", () => {
    const pills = ["red", "amber", "blue", "green"].flatMap((s) =>
      ["bg", "surface", "card"].map((b) => {
        const [r, g, bl] = color(s);
        return {
          pair: `--${s} on 13% of it over ${b}`,
          ratio: Math.round(ratio(color(s), over([r, g, bl, 0.13], color(b))) * 100) / 100,
        };
      }),
    );
    expect(pills.filter((p) => p.ratio < 4.5)).toEqual([]);
  });

  test("text on --raised (a selected tab) or a button's hover is --text or --text-2", () => {
    const lifted = [
      { name: "raised", rgb: color("raised") },
      ...["bg", "card"].map((s) => ({ name: `fill-3 over ${s}`, rgb: over(color("fill-3"), color(s)) })),
    ];
    expect(failures(["text", "text-2"], 4.5, lifted)).toEqual([]);
  });

  test("marks and the focus ring read at 3:1 on every surface", () => {
    expect(
      failures(
        MARKS,
        3,
        backgrounds.filter((b) => SURFACES.includes(b.name)),
      ),
    ).toEqual([]);
  });

  test("the text steps stay in order, brightest first", () => {
    const steps = ["text", "text-soft", "text-2", "text-3"].map((n) => luminance(color(n)));
    expect(steps).toEqual([...steps].sort((a, b) => b - a));
  });
});
