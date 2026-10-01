import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Every page of the shell is built from the page kit (components/page.tsx,
// THE-876): the shell's header bar is the page's only title, and the type is
// Geist and Geist Mono only. This walks each page and layout under
// app/(fleet) and app/organization through every local module it renders.
// The pages before the shell (sign in, welcome, device, invitation, THE-871)
// keep the type rules; their card's heading is their one h1.

const ROOT = resolve(import.meta.dir, "..");
const PAGE_DIRS = ["app/(fleet)", "app/organization"];
const AUTH_DIRS = ["app/login", "app/welcome", "app/device", "app/invitations"];

function entries(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return entries(path);
    return /^(page|layout)\.tsx$/.test(name) ? [path] : [];
  });
}

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

/** Every local module a file reaches through its imports (types included: they are cheap to scan). */
function reach(start: string, seen = new Set<string>()): Set<string> {
  if (seen.has(start)) return seen;
  seen.add(start);
  const source = readFileSync(start, "utf8");
  for (const [, spec] of source.matchAll(/(?:from|import)\s+"((?:@\/|\.)[^"]+)"/g)) {
    const file = spec && resolveImport(start, spec);
    if (file && /\.(tsx?)$/.test(file)) reach(file, seen);
  }
  return seen;
}

const pages = PAGE_DIRS.flatMap((d) => entries(join(ROOT, d)));
const modules = new Set(pages.flatMap((p) => [...reach(p)]));
const authPages = AUTH_DIRS.flatMap((d) => entries(join(ROOT, d)));
const authModules = new Set(authPages.flatMap((p) => [...reach(p)]));
const rel = (f: string) => relative(ROOT, f);

/** What a module may not do on a page of the shell. */
const FORBIDDEN: { what: string; pattern: RegExp }[] = [
  { what: "an h1 (the header bar is the page's title)", pattern: /<h1[\s>]|["']h1["']/ },
  { what: "a font family of its own", pattern: /fontFamily|font-family/ },
  { what: "the serif class", pattern: /className=\{?["'`][^"'`]*\bserif\b/ },
  { what: "a font import", pattern: /@fontsource|next\/font\/(?!local)|fonts\.googleapis/ },
];

describe("the pages of the shell", () => {
  test("are found, with the modules they render", () => {
    expect(pages.map(rel)).toContain("app/(fleet)/agents/page.tsx");
    expect(pages.map(rel)).toContain("app/organization/keys/page.tsx");
    expect([...modules].map(rel)).toContain("components/page.tsx");
  });

  for (const { what, pattern } of FORBIDDEN)
    test(`render no ${what}`, () => {
      const offenders = [...modules].filter((f) => pattern.test(readFileSync(f, "utf8"))).map(rel);
      expect(offenders).toEqual([]);
    });
});

describe("the pages before the shell", () => {
  test("are found, with the card they share", () => {
    expect(authPages.map(rel)).toEqual(
      expect.arrayContaining(["app/login/page.tsx", "app/welcome/page.tsx", "app/device/page.tsx"]),
    );
    expect([...authModules].map(rel)).toContain("components/AuthCard.tsx");
  });

  for (const { what, pattern } of FORBIDDEN.filter((f) => !f.what.startsWith("an h1")))
    test(`render no ${what}`, () => {
      const offenders = [...authModules].filter((f) => pattern.test(readFileSync(f, "utf8"))).map(rel);
      expect(offenders).toEqual([]);
    });
});

describe("the type scale", () => {
  test("globals.css sets no font but Geist and Geist Mono", () => {
    const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
    const families = [...css.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1]?.trim());
    expect(families.length).toBeGreaterThan(0);
    for (const family of families) expect(["var(--font-sans)", "var(--font-mono)"]).toContain(family ?? "");
    expect(css).not.toMatch(/Instrument|--font-display|\.serif\b/);
    expect(css).not.toMatch(/\bfont:\s*[^;]*serif/);
  });

  test("the dashboard loads no other font", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => d.includes("font"))).toEqual([]);
    expect(readFileSync(join(ROOT, "app/layout.tsx"), "utf8")).not.toContain("@fontsource");
  });
});

/** Every file that may render a class: the app, its components and its libraries. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("globals.css", () => {
  // No leftover style (THE-871): each class it styles is written in a source
  // file, as a word of a string. State modifiers (`is-…`) are composed at
  // runtime (`is-${tone}`), so only their base class is checked. The strings
  // of lib/i18n.ts are prose, not classes: a word there ("notes") proves nothing.
  test("styles no class that nothing renders", () => {
    const css = readFileSync(join(ROOT, "app/globals.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/url\([^)]*\)/g, "");
    const classes = new Set([...css.matchAll(/(?<![\w-])\.([a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? ""));
    const words = new Set<string>();
    const prefixes: string[] = [];
    const files = ["app", "components", "lib"].flatMap((d) => sources(join(ROOT, d)));
    for (const file of files.filter((f) => rel(f) !== "lib/i18n.ts")) {
      for (const m of readFileSync(file, "utf8").matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
        const text = m[1] ?? m[2] ?? m[3] ?? "";
        for (const word of text.split(/[\s{}$()]+/)) if (word) words.add(word);
        for (const p of text.matchAll(/([\w-]+-)\$\{/g)) if (p[1]) prefixes.push(p[1]);
      }
    }
    const unused = [...classes].filter(
      (c) => !c.startsWith("is-") && !words.has(c) && !prefixes.some((p) => c.startsWith(p)),
    );
    expect(unused).toEqual([]);
  });
});
