import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ChatItem } from "@armada/protocol";
import { type Browser, chromium, type Page } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import type { Group } from "../src/fleet/overview";
import { fenceTitle, folds, tableCsv, tableMarkdown } from "../src/room/markdown-rules";
import { Thread } from "../src/room/Thread";

// The room's thread read like T3 Code's (THE-2050), on a synthetic
// conversation: the markup first, then the clicks in a browser.

const AT = "2026-03-10T09:00:00.000Z";
const at = (minute: number) => new Date(Date.parse(AT) + minute * 60_000).toISOString();
const groups: Record<string, Group> = { "THE-12": "blocked" };
const LONG = Array.from(
  { length: 14 },
  (_, k) => `Berth ${k + 1} needs its hourly price checked against the tide.`,
).join(" ");

const answer = [
  "THE-12 waits on #34. Here is the fix:",
  "",
  "# Steps",
  "",
  '```ts title="src/berth.ts"',
  "export const price = (hours: number) => hours * 4;",
  "```",
  "",
  "| Berth | Hours | Price | Notes |",
  "| --- | --- | --- | --- |",
  "| North | 2 | 8 | Closed at low tide |",
  "",
  "> [!WARNING]",
  "> Tide tables change at noon.",
  "",
  "<details><summary>Why it waits</summary>The quay closes early.</details>",
  "",
  'Read [the tide service](https://tides.example.com/today) <script>alert(1)</script> <a href="https://x.example/" onclick="alert(1)" data-ticket="THE-12">here</a>.',
  "",
  'UTF-8 and HAR-9 are not this project\'s tickets. ![the chart](https://img.example/c.png?d=1) <img src="https://img.example/p.png"> [![CI](https://img.example/b.svg)](https://ci.example/run)',
  "",
  "Inline `THE-99` stays code.",
].join("\n");

const conversation: ChatItem[] = [
  { kind: "owner", id: "o1", at: at(1), body: LONG },
  { kind: "coordinator", id: "c1", at: at(2), body: answer },
  { kind: "coordinator", id: "c2", at: at(3), body: "" },
  { kind: "owner", id: "o2", at: at(4), body: "Merge THE-12\nthen look at #34" },
  // Each answer numbers its own footnotes from 1.
  { kind: "coordinator", id: "c3", at: at(5), body: "North quay[^1].\n\n[^1]: Footnote of the north." },
  { kind: "coordinator", id: "c4", at: at(6), body: "South quay[^1].\n\n[^1]: Footnote of the south." },
  { kind: "wake", id: "w1", at: at(7), body: "Woke: hand-back THE-12 #34 at aaaaaaaa" },
];

const render = () =>
  renderToStaticMarkup(
    <Thread
      items={conversation}
      repository="example/harbor"
      prefixes="THE"
      groupOf={(ticket) => groups[ticket] ?? null}
      now={Date.parse("2026-03-10T15:00:00.000Z")}
      zone="UTC"
      empty="Nothing said yet."
    />,
  );
const item = (html: string, id: number) => html.split(/<li /)[id + 1] ?? "";
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("the thread's markup", () => {
  test("a fleet wake is a quiet row with ticket and PR links, outside the owner's bubble", () => {
    const html = renderToStaticMarkup(
      <Thread
        items={[conversation[6] as ChatItem]}
        repository="example/harbor"
        prefixes="THE"
        groupOf={() => null}
        now={Date.parse(AT)}
        zone="UTC"
        empty="Nothing said yet."
      />,
    );
    expect(text(html)).toContain("Woke: hand-back THE-12 #34 at aaaaaaaa");
    expect(html).toContain("data-wake");
    expect(html).toContain("#/sessions/THE-12");
    expect(html).toContain("https://github.com/example/harbor/pull/34");
    expect(html).not.toContain("You: ");
    expect(html).not.toContain("bg-panel-3");
  });
  test("a code block is a card with its file's name, Wrap lines and Copy", () => {
    const html = item(render(), 1);
    const block = html.match(/<div[^>]*data-code-block[^>]*>[\s\S]*?<\/pre><\/div>/)?.[0] ?? "";
    expect(block).toContain('data-language="ts"');
    expect(block).toMatch(/data-code-title="?"?[^>]*>src\/berth\.ts</);
    expect(block).toMatch(/aria-label="Wrap lines"[^>]*aria-pressed="true"/);
    expect(block).toContain('aria-label="Copy code"');
    expect(text(block)).toContain("export const price = (hours: number) =&gt; hours * 4;");
  });

  test("a table scrolls sideways in the lane, with its copy menu", () => {
    const html = item(render(), 1);
    expect(html).toMatch(/<div[^>]*class="[^"]*overflow-x-auto[^"]*"[^>]*><table>/);
    expect(html).toMatch(/aria-label="Copy table"/);
    expect(html).not.toMatch(/<table[^>]*style=/);
  });

  test("a 700-character owner message is a folded bubble with Show full message", () => {
    expect(LONG.length).toBeGreaterThan(700);
    const html = item(render(), 0);
    expect(html).toContain("rounded-deck");
    expect(html).toMatch(/data-folded="true"[^>]*style="mask-image:linear-gradient/);
    expect(html).toContain("max-h-44");
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Show full message<\/button>/);
    // A short one does not fold, and keeps its line breaks.
    const short = item(render(), 3);
    expect(short).not.toContain("Show full message");
    expect(short).toMatch(/Merge <a[^>]*>THE-12<\/a><br\/>/);
  });

  test("a ticket id links to its session in its state's colour, #34 to the pull request, not inside code", () => {
    const html = item(render(), 1);
    expect(html).toMatch(/<a href="#\/sessions\/THE-12" data-ticket="THE-12" class="[^"]*text-red[^"]*">THE-12<\/a>/);
    expect(html).toMatch(
      /<a href="https:\/\/github\.com\/example\/harbor\/pull\/34" data-pr="#34" target="_blank" rel="noopener noreferrer"[^>]*>#34<\/a>/,
    );
    expect(html).toContain("<code>THE-99</code>");
  });

  test("an external link opens outside the app; raw HTML is sanitized, details open as a disclosure", () => {
    const html = item(render(), 1);
    expect(html).toMatch(
      /<a href="https:\/\/tides\.example\.com\/today" target="_blank" rel="noopener noreferrer" class="[^"]*text-blue[^"]*">the tide service<\/a>/,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    // Raw HTML cannot pass for a ticket's link.
    expect(html).toMatch(
      /<a href="https:\/\/x\.example\/" target="_blank" rel="noopener noreferrer" class="[^"]*text-blue[^"]*">here<\/a>/,
    );
    expect(html).toMatch(/<details[^>]*><summary[^>]*><svg[^>]*>[\s\S]*?<span>Why it waits<\/span><\/summary>/);
  });

  test("images are never fetched: a markdown image becomes a link to it, a raw one is dropped", () => {
    const html = item(render(), 1);
    expect(html).not.toMatch(/<img\b/);
    expect(html).toMatch(/<a href="https:\/\/img\.example\/c\.png\?d=1" target="_blank"[^>]*>the chart<\/a>/);
    expect(html).not.toContain("p.png");
    // A linked image (a badge) is its link, worded by its alt text.
    expect(html).toMatch(/<a href="https:\/\/ci\.example\/run" target="_blank"[^>]*>CI<\/a>/);
    expect(html).not.toContain("b.svg");
  });

  test("only the project's own ticket ids link: UTF-8 and another team's id stay words", () => {
    const words = text(item(render(), 1));
    expect(words).toContain("UTF-8 and HAR-9 are not this project's tickets.");
    expect(item(render(), 1)).not.toMatch(/<a[^>]*>(UTF-8|HAR-9)<\/a>/);
  });

  test("headings sit under the page's title, alerts have their word, an empty answer says so", () => {
    const html = render();
    expect(html).not.toMatch(/<h[12]\b/);
    expect(item(html, 1)).toMatch(/<h3 class="chat-heading text-\[1\.25rem\]">Steps<\/h3>/);
    expect(text(item(html, 1).match(/<div role="note" data-alert="warning"[\s\S]*?<\/div><\/div>/)?.[0] ?? "")).toBe(
      "Warning Tide tables change at noon.",
    );
    expect(text(item(html, 2))).toContain("Coordinator: (empty response)");
    // The meta rows: shown on hover or focus, the time with its full date.
    expect(item(html, 1)).toMatch(/data-meta/);
    expect(item(html, 1)).toMatch(/opacity-0[^"]*group-hover\/row:opacity-100/);
    expect(item(html, 1)).toContain('title="Tuesday, 10 March 2026 at 09:02"');
  });

  test("the rules: when a message folds, a fence's name, a table on the clipboard", () => {
    expect(folds("a".repeat(600))).toBe(false);
    expect(folds("a".repeat(601))).toBe(true);
    expect(folds(Array(9).fill("a").join("\n"))).toBe(true);
    expect(fenceTitle('title="a b.ts"')).toBe("a b.ts");
    expect(fenceTitle("src/x.ts {1}")).toBe("src/x.ts");
    expect(fenceTitle("{1-3}")).toBeNull();
    const rows = [
      ["Berth", "Note"],
      ["North", 'a | "b", c'],
    ];
    expect(tableMarkdown(rows)).toBe('| Berth | Note |\n| --- | --- |\n| North | a \\| "b", c |');
    expect(tableCsv(rows)).toBe('Berth,Note\nNorth,"a | ""b"", c"');
  });
});

describe("the thread in a browser", () => {
  const ORIGIN = "https://thread.test";
  let browser: Browser | undefined;
  let page: Page;
  let bundle = "";

  // The page's bundle and the headless shell (installed before the suite) are setup, not behaviour deadlines.
  beforeAll(async () => {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "thread-page.tsx")],
      target: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!built.success) throw new Error(built.logs.join("\n"));
    bundle = (await built.outputs[0]?.text()) ?? "";
    browser = await chromium.launch({ timeout: 15_000 });
  }, 30_000);
  beforeAll(async () => {
    if (!browser) throw new Error("browser setup did not complete");
    const context = await browser.newContext();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
    page = await context.newPage();
    // No network: the page and its script are served here, anything else is refused.
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/`)
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><div id="root"></div><script>window.THREAD=${JSON.stringify({ items: conversation, groups }).replace(/</g, "\\u003c")}</script><script type="module" src="/thread.js"></script>`,
        });
      if (url === `${ORIGIN}/thread.js`) return route.fulfill({ contentType: "text/javascript", body: bundle });
      return route.abort();
    });
    await page.goto(`${ORIGIN}/`);
    await page.locator("[data-thread]").waitFor({ timeout: 5_000 });
  }, 10_000);
  afterAll(async () => {
    await browser?.close();
  }, 10_000);

  test("Show full message opens the owner's long message, Show less folds it again", async () => {
    const open = page.getByRole("button", { name: "Show full message" });
    const body = page.locator('[data-item="owner"] [data-folded]');
    await expect(body.getAttribute("data-folded")).resolves.toBe("true");
    await open.click();
    await expect(body.getAttribute("data-folded")).resolves.toBe("false");
    const less = page.getByRole("button", { name: "Show less" });
    await expect(less.getAttribute("aria-expanded")).resolves.toBe("true");
    await less.click();
    await expect(body.getAttribute("data-folded")).resolves.toBe("true");
  });

  test("an external link does not navigate the app: it opens apart", async () => {
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    const popup = page.waitForEvent("popup", { timeout: 5_000 });
    await page.getByRole("link", { name: "the tide service" }).click();
    await popup.then((p) => p.close());
    expect(page.url()).toBe(`${ORIGIN}/`);
    expect(navigations).toEqual([]);
  });

  test("Copy puts the code on the clipboard and says Copied", async () => {
    await page.getByRole("button", { name: "Copy code" }).click();
    await page.getByRole("button", { name: "Copied" }).waitFor({ timeout: 2_000 });
    await expect(page.evaluate(() => navigator.clipboard.readText())).resolves.toBe(
      "export const price = (hours: number) => hours * 4;",
    );
  });

  test("the table's menu copies it as CSV, then closes and gives the focus back", async () => {
    const trigger = page.getByRole("button", { name: "Copy table" });
    await trigger.click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem").allTextContents()).resolves.toEqual(["Copy as Markdown", "Copy as CSV"]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await menu.waitFor({ state: "detached", timeout: 2_000 });
    await expect(page.evaluate(() => navigator.clipboard.readText())).resolves.toBe(
      "Berth,Hours,Price,Notes\nNorth,2,8,Closed at low tide",
    );
    await expect(page.evaluate(() => document.activeElement?.getAttribute("aria-haspopup"))).resolves.toBe("menu");
  });

  test("a footnote's link scrolls to the note of its own message, never to another's, and leaves the address", async () => {
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { scrolled: string[] }).scrolled = seen;
      Element.prototype.scrollIntoView = function (this: Element) {
        seen.push(this.textContent ?? "");
      };
    });
    await page.locator('[data-item="coordinator"]').last().locator("sup a").click();
    const scrolled = await page.evaluate(() => (window as unknown as { scrolled: string[] }).scrolled);
    expect(scrolled.join(" ")).toContain("Footnote of the south");
    expect(page.url()).toBe(`${ORIGIN}/`);
  });
});
