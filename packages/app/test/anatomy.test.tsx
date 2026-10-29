import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/App";
import { THEME_NAMES } from "../src/lib/utils";
import { createDaemonClient, type SocketLike } from "../src/protocol/client";

// The v7 anatomy (design/dashboard-v7): the title line is the page's only h1,
// and the type is Geist and Geist Mono only. This walks every source of the app.

const ROOT = resolve(import.meta.dir, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
const sources = [...files(join(ROOT, "src")), join(ROOT, "index.html")].filter((f) => /\.(tsx?|css|html)$/.test(f));
const rel = (f: string) => relative(ROOT, f);
const read = (f: string) => readFileSync(f, "utf8");

/** The title line: the one module that may render an h1. */
const TITLE_LINE = "src/components/page.tsx";
const FAMILIES = new Set(["Geist", "Geist Mono"]);
const GENERIC = new Set(["sans-serif", "monospace", "ui-sans-serif", "ui-monospace"]);

/** Each font a CSS family list names, quotes removed; `var(--font-sans|mono)` stand for the theme's own. */
function namedFonts(list: string): string[] {
  return list
    .split(",")
    .map((f) => f.trim().replace(/^["']|["']$/g, ""))
    .filter((f) => f && !GENERIC.has(f) && !/^var\(--font-(sans|mono)\)$/.test(f) && f !== "inherit");
}

describe("the app's sources", () => {
  test("are found, with the title line and the theme", () => {
    expect(sources.map(rel)).toEqual(expect.arrayContaining([TITLE_LINE, "src/styles.css", "src/App.tsx"]));
  });

  test("render no h1 outside the title line", () => {
    const h1 = /<h1[\s>]|["'`]h1["'`]|createElement\(\s*["']h1/;
    expect(read(join(ROOT, TITLE_LINE))).toMatch(h1);
    expect(sources.filter((f) => rel(f) !== TITLE_LINE && h1.test(read(f))).map(rel)).toEqual([]);
  });

  test("name no font but Geist and Geist Mono", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const text = read(file);
      // A family list: `font-family`, `--default-font-family` and the like, or a `--font-*` token (not a weight, nor a token's `--font-mono--…` setting).
      for (const [, , list] of text.matchAll(
        /(?<![\w-])(--[a-z-]*font-family|font-family|--font-(?!weight)[a-z]+(?:-[a-z0-9]+)*)\s*:\s*([^;}]+)/g,
      )) {
        if (/initial/.test(list ?? "")) continue;
        for (const font of namedFonts(list ?? "")) if (!FAMILIES.has(font)) offenders.push(`${rel(file)}: ${font}`);
      }
      for (const [, src] of text.matchAll(/@font-face\s*{[^}]*src:\s*([^;]+)/g))
        if (!/url\("\.\/fonts\/geist(-mono)?\.woff2"\)/.test(src ?? "")) offenders.push(`${rel(file)}: ${src}`);
      // The `font:` shorthand would hide a family among the size and weight: the tokens set fonts.
      if (/(?<![\w-])font\s*:/.test(text)) offenders.push(`${rel(file)}: the font shorthand`);
      if (/fontFamily|font-\[|font-\(|@fontsource|fonts\.(googleapis|gstatic)|@import\s+url/.test(text))
        offenders.push(`${rel(file)}: a font of its own`);
    }
    expect(offenders).toEqual([]);
    // The theme itself names both, so the rule above has something to hold.
    const theme = read(join(ROOT, "src/styles.css"));
    expect(theme).toMatch(/--font-sans:\s*"Geist",/);
    expect(theme).toMatch(/--font-mono:\s*"Geist Mono",/);
    expect(theme).toMatch(/--font-\*:\s*initial/);
  });

  test("tell cn every type, radius and shadow name of the theme", () => {
    const theme = read(join(ROOT, "src/styles.css"));
    const names = (prefix: string) =>
      [...theme.matchAll(new RegExp(`^\\s*--${prefix}-([a-z0-9-]+):`, "gm"))]
        .map((m) => m[1] ?? "")
        .filter((n) => !n.includes("--") && !/--/.test(n));
    expect(THEME_NAMES.text).toEqual(names("text").filter((n) => !/-$/.test(n)));
    expect(THEME_NAMES.radius).toEqual(names("radius"));
    expect(THEME_NAMES.shadow).toEqual(names("shadow"));
  });
});

test("the shell renders one h1, the hangar's title, on its line of facts", () => {
  const quiet: SocketLike = { send() {}, close() {}, onopen: null, onmessage: null, onclose: null };
  const client = createDaemonClient({ url: "ws://daemon.test/", open: () => quiet, schedule: () => () => {} });
  const html = renderToStaticMarkup(<App client={client} address="ws://daemon.test/" onReload={() => {}} />);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toMatch(/<header[^>]*><h1[^>]*>Hangar<\/h1><span>Waiting for the daemon<\/span>/);
  expect(html).toContain('aria-label="Sidebar"');
});
