import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Every page of the shell is built from the page kit (components/page.tsx,
// THE-876): the shell's header bar is the page's only title, and the type is
// Geist and Geist Mono only. This walks each page and layout under
// app/(fleet) and app/organization through every local module it renders.

const ROOT = resolve(import.meta.dir, "..");
const PAGE_DIRS = ["app/(fleet)", "app/organization"];

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
