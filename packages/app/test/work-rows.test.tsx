import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ChatItem } from "@armada/protocol";
import { type Browser, chromium, type Page } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import type { Group } from "../src/fleet/overview";
import { Thread } from "../src/room/Thread";

// The coordinator's work as T3 Code's rows (THE-2053), on a synthetic
// conversation: on a fleet notice the coordinator reads the fleet and says a
// line on its own; the owner asks, the coordinator reads the fleet and
// launches (one launch refused), then answers 2m 03s after its first call; the
// owner asks again and one call is still running. The markup first, then the
// clicks in a browser.

const AT = "2026-03-10T09:00:00.000Z";
const at = (second: number) => new Date(Date.parse(AT) + second * 1000).toISOString();
const groups: Record<string, Group> = { "THE-9": "merged", "THE-12": "running" };
type Tool = Extract<ChatItem, { kind: "tool" }>;
const call = (id: string, second: number, name: string, input: Tool["input"], extra: Partial<Tool> = {}): Tool => ({
  kind: "tool",
  id,
  at: at(second),
  name,
  input,
  output: '{"ok":true}',
  failed: false,
  ...extra,
});
const MERGE_REFUSED = JSON.stringify({
  ok: false,
  code: "checks_red",
  message: "legacy message",
  reason: "Red: Lint, typecheck and test on 9c46a81",
  next: "ask the worker (worker.message) to fix and hand back",
});
const REFUSED = '{"ok":false,"code":"cap","message":"two workers already run","next":"fleet.status"}';

const notice: ChatItem[] = [
  call("t0", -60, "fleet.status", {}),
  { kind: "line", id: "l1", at: at(-48), body: "THE-9 merged." },
];
const work: ChatItem[] = [
  { kind: "owner", id: "o1", at: at(0), body: "Launch THE-12 and THE-14." },
  call("t1", 5, "fleet.status", {}),
  call("t2", 9, "worker.launch", { ticket: "THE-12" }),
  call("t3", 30, "fleet.status", {}),
  call("t4", 40, "worker.launch", { ticket: "THE-14" }, { output: REFUSED, failed: true }),
];
const conversation: ChatItem[] = [
  ...notice,
  ...work,
  { kind: "coordinator", id: "c1", at: at(128), body: "THE-12 is launched; THE-14 waits for a slot." },
  { kind: "owner", id: "o2", at: at(200), body: "Check #34." },
  call("t5", 201, "merge.check", { pr: 34 }, { output: null }),
];

const render = (items: ChatItem[]) =>
  renderToStaticMarkup(
    <Thread
      items={items}
      repository="example/harbor"
      prefixes="THE"
      groupOf={(ticket) => groups[ticket] ?? null}
      now={Date.parse("2026-03-10T15:00:00.000Z")}
      zone="UTC"
      empty="Nothing said yet."
    />,
  );
const rows = (html: string) =>
  html
    .split(/<li /)
    .slice(1)
    .map((li) => `<li ${li}`);
const kinds = (html: string) => rows(html).map((li) => li.match(/data-item="([a-z]+)"/)?.[1]);
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

describe("the work's markup", () => {
  test("a finished turn folds into Worked for 2m 03s above its answer; a line folds its own turn and stays outside with its dot", () => {
    const html = render(conversation);
    expect(kinds(html)).toEqual(["fold", "line", "owner", "fold", "coordinator", "owner", "tool"]);
    const [noticed = "", line = "", , fold = ""] = rows(html);
    expect(text(noticed)).toBe("Worked for 12s 08:59");
    expect(fold).toMatch(/<div class="[^"]*border-b[^"]*" data-fold/);
    expect(fold).toMatch(/opacity-0[^"]*group-hover\/row:opacity-100[^"]*"><time[^>]*>09:00</);
    expect(line).toContain("data-line");
    expect(line).not.toContain("data-tool");
    expect(line).toMatch(/data-dot="merged"/);
    expect(text(line)).toBe("THE-9 merged. 08:59");
  });

  test("a single call is its own row: its sentence, its name on hover", () => {
    const single = rows(render(conversation)).at(-1) ?? "";
    expect(single).toContain('data-tool="merge.check"');
    expect(single).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-label="Checked #34"/);
    expect(single).toMatch(/<span title="merge.check">Checked <span[^>]*>#34<\/span><\/span>/);
    expect(single).toContain("min-h-6");
    expect(single).not.toContain("data-failed");
  });

  test("a turn's calls not yet answered are one group: its sentence, a red X and its aria-label for the failure", () => {
    const html = render([...work, { kind: "owner", id: "o2", at: at(200), body: "Wait." }]);
    expect(kinds(html)).toEqual(["owner", "work", "owner"]);
    const group = rows(html)[1] ?? "";
    expect(group).toMatch(/data-work="4"/);
    expect(group).toMatch(
      /<button[^>]*aria-label="Read the fleet 2 times and launched 2 workers, tool call failed"[^>]*>/,
    );
    expect(text(group)).toBe("Read the fleet 2 times and launched 2 workers");
    expect(group).toMatch(/<svg[^>]*class="lucide lucide-x[^"]*text-red"[^>]*data-failed/);
  });
});

describe("the work in a browser", () => {
  const ORIGIN = "https://work.test";
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
    page = await context.newPage();
    // No network: the page and its script are served here, anything else is refused.
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/` || url === `${ORIGIN}/?merge`)
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><div id="root"></div><script>window.THREAD=${JSON.stringify({ items: url.endsWith("?merge") ? [call("red", 1, "merge.run", { pr: 34 }, { failed: true, output: MERGE_REFUSED })] : conversation, groups, project: "harbor" }).replace(/</g, "\\u003c")}</script><script type="module" src="/thread.js"></script>`,
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

  test("the fold opens into the group, the group into its rows, a refused row into its amber refusal; kept on reload", async () => {
    const fold = page.getByRole("button", { name: "Worked for 2m 03s" });
    await fold.click();
    expect(await fold.getAttribute("aria-expanded")).toBe("true");
    const group = page.getByRole("button", { name: "Read the fleet 2 times and launched 2 workers, tool call failed" });
    await group.click();
    const calls = page.locator('[data-item="fold"] [data-tool]');
    expect(await calls.evaluateAll((els) => els.map((el) => el.getAttribute("data-tool")))).toEqual([
      "fleet.status",
      "worker.launch",
      "fleet.status",
      "worker.launch",
    ]);
    // The rows scroll inside the group when there are many.
    expect(await calls.first().evaluate((el) => el.parentElement?.className ?? "")).toContain(
      "max-h-[min(18rem,50dvh)]",
    );
    const failed = page.getByRole("button", { name: "Launched THE-14, tool call failed" });
    expect(await failed.locator("[data-failed]").count()).toBe(1);
    await failed.click();
    const refusal = page.getByText("Refused: two workers already run → fleet.status");
    await refusal.waitFor();
    expect(await refusal.evaluate((el) => el.className)).toContain("text-amber");
    await page.getByText('"code": "cap"').waitFor();
    // The other launch has no X.
    expect(
      await page.getByRole("button", { name: "Launched THE-12", exact: true }).locator("[data-failed]").count(),
    ).toBe(0);

    // The project's open rows are kept for the tab.
    await page.reload();
    await page.getByText("Refused: two workers already run → fleet.status").waitFor({ timeout: 5_000 });
    // Folded again, the work leaves; the answer stays below.
    await page.getByRole("button", { name: "Worked for 2m 03s" }).click();
    expect(await page.locator("[data-tool]").count()).toBe(1);
    await page.getByText("THE-12 is launched; THE-14 waits for a slot.").waitFor();
  });
  test("a refused merge shows its reason and next tool below the row before opening raw details", async () => {
    await page.goto(`${ORIGIN}/?merge`);
    const row = page.locator('[data-tool="merge.run"]');
    await row
      .getByText(
        "Refused: Red: Lint, typecheck and test on 9c46a81 → ask the worker (worker.message) to fix and hand back",
      )
      .waitFor({ timeout: 2_000 });
    expect(await row.getByRole("button").getAttribute("aria-expanded")).toBe("false");
    expect(await row.getByText("legacy message", { exact: true }).count()).toBe(0);
    await row.getByRole("button").click();
    await row.getByText("Input", { exact: true }).waitFor();
    await row.getByText("Result", { exact: true }).waitFor();
    expect(await row.getByText("Refused:", { exact: false }).count()).toBe(1);
  });
});
