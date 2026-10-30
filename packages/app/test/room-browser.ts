// The room's panel page (test/room-panel-page.tsx) in Chromium, shared by its
// browser tests (THE-2085's panel, THE-2089's agent lane): the page's bundle
// and the app's own Tailwind build of the classes it names, served on a fake
// origin with no network, a seed handed to the page before it loads.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { compile } from "tailwindcss";

const ORIGIN = "http://room-panel.test";
const ROOT = resolve(import.meta.dir, "..");

/** The app's own stylesheet, built for the classes the page's bundle names. */
async function stylesFor(bundle: string): Promise<string> {
  const tailwind = dirname(Bun.resolveSync("tailwindcss/package.json", ROOT));
  const compiler = await compile(readFileSync(join(ROOT, "src/styles.css"), "utf8"), {
    base: join(ROOT, "src"),
    loadStylesheet: async (id: string, base: string) => {
      const path = id === "tailwindcss" ? join(tailwind, "index.css") : join(base, id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  return compiler.build([...new Set(bundle.match(/[^\s"'`\\<>{};,]+/g) ?? [])]);
}

export interface RoomBrowser {
  /** The room on a fresh page, `width` × `height`, at `hash`. */
  open(width?: number, hash?: string, height?: number): Promise<Page>;
  close(): Promise<void>;
}

/** Builds the page and starts the headless shell: setup, run in a suite's `beforeAll`. */
export async function roomBrowser(seed: string): Promise<RoomBrowser> {
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "room-panel-page.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const bundle = (await built.outputs[0]?.text()) ?? "";
  const css = await stylesFor(bundle);
  const browser: Browser = await chromium.launch({ timeout: 15_000 });
  return {
    async open(width = 1280, hash = "#/projects/harbor", height = 800) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      // A step that does not happen fails on its own line, before the test's deadline.
      page.setDefaultTimeout(2_000);
      await context.addInitScript((json) => {
        (window as unknown as { seed: unknown }).seed = JSON.parse(json);
      }, seed);
      // No network: the page, its styles and its script are served here, anything else is refused.
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === ORIGIN && url.pathname === "/")
          return route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html class="dark"><style>${css}</style><body style="margin:0"><div id="root"></div><script type="module" src="/room.js"></script></body></html>`,
          });
        if (url.href === `${ORIGIN}/room.js`) return route.fulfill({ contentType: "text/javascript", body: bundle });
        return route.abort();
      });
      await page.goto(`${ORIGIN}/${hash}`);
      await page.locator("[data-room]").waitFor({ timeout: 5_000 });
      return page;
    },
    close: () => browser.close(),
  };
}
