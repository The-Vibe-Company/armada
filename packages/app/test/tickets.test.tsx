import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { settled, stylesFor } from "./room-browser";

// The Tickets page (THE-2124) in a browser, on the app's own client over a
// fake daemon (test/add-project-page.tsx): on an internal project, New ticket
// sends `ticket.create`, the ticket lands in the backlog, Mark ready sends
// `ticket.update` and it moves under "ready to launch"; a refusal shows in red
// under the form; on a Linear project one quiet line replaces the form.

const ORIGIN = "http://tickets.test";
const ORCHARD = { id: "orchard", name: "Orchard", repository: "example/orchard", tracker: "internal" };
const MEADOW = { id: "meadow", name: "Meadow", repository: "example/meadow", tracker: "linear", root: "MEAD-1" };
const EMPTY = { sessions: [], tickets: [], pullRequests: [], inbox: [], queue: [], validations: [] };

type Sent = { type: string; id: string } & Record<string, unknown>;

describe("the Tickets page in a browser", () => {
  let browser: Browser | undefined;
  let page: Page;
  let bundle = "";
  let css = "";
  let seq = 0;

  beforeAll(async () => {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "add-project-page.tsx")],
      target: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!built.success) throw new Error(built.logs.join("\n"));
    bundle = (await built.outputs[0]?.text()) ?? "";
    css = await stylesFor(bundle);
    browser = await chromium.launch({ timeout: 15_000 });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    page = await context.newPage();
    page.setDefaultTimeout(2_000);
    // No network: the page and its script are served here, anything else is refused.
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === ORIGIN && url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html class="dark"><style>${css}</style><body style="margin:0;height:100vh"><div id="root" style="height:100%"></div><script type="module" src="/app.js"></script></body></html>`,
        });
      if (url.href === `${ORIGIN}/app.js`) return route.fulfill({ contentType: "text/javascript", body: bundle });
      return route.abort();
    });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  }, 10_000);

  const receive = (message: Record<string, unknown>) =>
    page.evaluate((m) => (window as unknown as { fake: { receive(m: unknown): void } }).fake.receive(m), message);
  /** The last request of this type the client sent, once it sent one more than `before`. */
  const sent = async (type: string, before = 0): Promise<Sent> => {
    await page.waitForFunction(
      ([t, n]) => (window as unknown as { fake: { sent: Sent[] } }).fake.sent.filter((m) => m.type === t).length > n,
      [type, before] as const,
    );
    const all = await page.evaluate(() => (window as unknown as { fake: { sent: Sent[] } }).fake.sent);
    return all.filter((m) => m.type === type).at(-1) as Sent;
  };
  /** The project's folded state, as the daemon's next frame carries it. */
  const fold = (project: string, state: object) => {
    seq += 1;
    return receive({
      type: "events",
      project,
      subscriptionId: `sub-${project}`,
      seq,
      events: [],
      snapshot: { seq, state: { ...EMPTY, ...state } },
    });
  };
  const group = (name: string) => page.locator(`[data-ticket-group="${name}"]`);

  /** A fresh page at the project's tickets, the daemon listing these projects, each folded empty. */
  async function open(projects: { id: string }[], at: string) {
    seq = 0;
    await page.goto(`${ORIGIN}/${at}`);
    await page.evaluate(() => (window as unknown as { fake: { open(): void } }).fake.open());
    await receive({ type: "projects.result", id: "r1", projects });
    for (const item of projects) {
      await receive({
        type: "project.subscribed",
        id: `sub-${item.id}`,
        project: item.id,
        subscriptionId: `sub-${item.id}`,
        after: 0,
      });
      await fold(item.id, {});
    }
    await page.locator("[data-tickets]").waitFor();
  }

  test("a new ticket lands in the backlog, and Mark ready moves it under ready to launch", async () => {
    await open([ORCHARD, MEADOW], "#/projects/orchard/tickets");
    // The page kit's bar: its one title, the project, each group's count.
    expect(await page.locator("h1").allTextContents()).toEqual(["Tickets"]);
    expect(await group("ready").getByText("Nothing is ready to launch.").count()).toBe(1);
    expect(await page.locator("[data-linear-line]").count()).toBe(0);

    await page.getByRole("button", { name: "New ticket", exact: true }).click();
    const form = page.locator('[data-ticket-form="new"]');
    await form.getByLabel("Title", { exact: true }).fill("Prune the pear trees");
    await form.getByLabel("Description", { exact: true }).fill("Before **spring**.");
    await form.getByLabel("Labels", { exact: true }).fill("web, orchard");
    await form.getByRole("button", { name: "Create ticket" }).click();
    const create = await sent("ticket.create");
    expect(create).toMatchObject({
      project: "orchard",
      title: "Prune the pear trees",
      description: "Before **spring**.",
      labels: ["web", "orchard"],
    });
    expect(create.ready).toBeUndefined();

    // The daemon refuses once: the line shows in red under the form, which stays.
    await receive({ type: "error", id: create.id, code: "denied", message: "the project's tracker is unavailable" });
    const problem = form.locator("[data-ticket-problem]");
    await problem.waitFor();
    expect(await problem.textContent()).toBe("the project's tracker is unavailable");
    expect(await problem.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(253, 115, 109)");

    // The daemon answered: the ticket sent again is a new write, with a new request id.
    await form.getByRole("button", { name: "Create ticket" }).click();
    const again = await sent("ticket.create", 1);
    expect(again.requestId).not.toBe(create.requestId);
    const ticket = {
      id: "ORCHA-1",
      title: "Prune the pear trees",
      description: "Before **spring**.",
      labels: ["web", "orchard"],
      status: "backlog",
      parent: null,
      blockers: [],
      comments: [{ body: "Mind the **frost**.", author: "owner", at: "2026-11-02T09:00:00.000Z" }],
    };
    await fold("orchard", { tickets: [ticket] });
    await receive({
      type: "ticket.result",
      id: again.id,
      project: "orchard",
      requestId: again.requestId,
      ticket: "ORCHA-1",
    });
    // The panel shows the new ticket: its title, its description as Markdown, its comment.
    const detail = page.locator('[data-ticket-detail="ORCHA-1"]');
    await detail.waitFor();
    expect(await page.evaluate(() => window.location.hash)).toBe("#/projects/orchard/tickets?ticket=ORCHA-1");
    expect(await detail.locator("strong").allTextContents()).toEqual(["spring", "frost"]);
    expect(await group("backlog").locator('[data-ticket-row="ORCHA-1"] [data-label]').allTextContents()).toEqual([
      "web",
      "orchard",
    ]);

    await detail.getByRole("button", { name: "Mark ready" }).click();
    const ready = await sent("ticket.update");
    expect(ready).toMatchObject({ project: "orchard", ticket: "ORCHA-1", addLabels: ["ready-for-agent"] });
    await fold("orchard", { tickets: [{ ...ticket, labels: [...ticket.labels, "ready-for-agent"] }] });
    await receive({
      type: "ticket.result",
      id: ready.id,
      project: "orchard",
      requestId: ready.requestId,
      ticket: "ORCHA-1",
    });
    await settled(() => group("ready").locator('[data-ticket-row="ORCHA-1"]').count(), 1);
    expect(await group("backlog").locator("[data-ticket-row]").count()).toBe(0);
    expect(await page.locator('[data-fact="ready"]').textContent()).toBe("1ready to launch");
    // Edit sends only what the owner changed, here its description.
    await detail.getByRole("button", { name: "Edit" }).click();
    const edit = page.locator('[data-ticket-form="edit"]');
    expect(await edit.getByLabel("Labels", { exact: true }).inputValue()).toBe("web, orchard");
    await edit.getByLabel("Description", { exact: true }).fill("Before **spring**, row by row.");
    await edit.getByRole("button", { name: "Save" }).click();
    const edited = await sent("ticket.update", 1);
    expect(
      Object.keys(edited).filter((k) => !["type", "version", "id", "project", "requestId", "ticket"].includes(k)),
    ).toEqual(["description"]);
    await receive({
      type: "ticket.result",
      id: edited.id,
      project: "orchard",
      requestId: edited.requestId,
      ticket: "ORCHA-1",
    });
    await detail.waitFor();
    // Ready, it can be launched: the coordinator is asked, as the room's own ask does.
    expect(await detail.getByRole("button", { name: "Not ready" }).count()).toBe(1);
    await detail.getByRole("button", { name: "Launch" }).click();
    const launch = await sent("chat.send");
    expect(launch).toMatchObject({ project: "orchard", body: "Launch ORCHA-1" });
  }, 20_000);

  test("a Linear project shows its tickets read-only, with one quiet line for the form", async () => {
    await open([ORCHARD, MEADOW], "#/projects/meadow/tickets?new");
    await fold("meadow", {
      tickets: [
        { id: "MEAD-1", title: "Meadow program", status: "started", url: "https://linear.app/example/issue/MEAD-1" },
        {
          id: "MEAD-2",
          title: "Mow the east field",
          status: "unstarted",
          parent: "MEAD-1",
          labels: ["ready-for-agent"],
          blockers: [],
        },
      ],
    });
    const line = page.locator("[data-linear-line]");
    expect(await line.textContent()).toBe("This project's tickets live in Linear · MEAD-1");
    expect(await line.getByRole("link", { name: "MEAD-1" }).getAttribute("href")).toBe(
      "https://linear.app/example/issue/MEAD-1",
    );
    expect(await page.getByRole("button", { name: "New ticket" }).count()).toBe(0);
    // `?new` on Linear shows the same line, never the form.
    expect(await page.locator("[data-ticket-form]").count()).toBe(0);
    expect(await page.locator("#ticket-panel").getByText("This project's tickets live in Linear").count()).toBe(1);
    // The list still shows them: the row names its parent; its panel has no write.
    expect(await group("ready").locator('[data-ticket-row="MEAD-2"] [data-parent]').textContent()).toBe(
      "Parent MEAD-1",
    );
    await group("ready")
      .getByRole("link", { name: /MEAD-2/ })
      .click();
    const detail = page.locator('[data-ticket-detail="MEAD-2"]');
    await detail.waitFor();
    for (const name of ["Mark ready", "Not ready", "Edit", "Cancel ticket"])
      expect(await detail.getByRole("button", { name }).count()).toBe(0);
    expect(await detail.getByRole("button", { name: "Launch" }).count()).toBe(1);
  }, 20_000);
});
