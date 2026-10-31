import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { settled, stylesFor } from "./room-browser";

// Add project and Remove project (THE-2081) in a browser, on the app's own
// client over a fake daemon and the desktop shell's fake folder picker: the
// empty hangar's hero, Browse and the daemon's inspection, the form it
// prefills, a folder without a remote, Add and the daemon's answer, a
// refusal, the keyboard, a browser without the picker, then Remove project
// from a room's rules and the daemon's refusal while a worker flies.

const ORIGIN = "http://add-project.test";
const KESTREL = { id: "kestrel", name: "Kestrel", repository: "example/kestrel" };
const ARMADA = {
  path: "/Users/owner/Dev/armada",
  git: { remote: "The-Vibe-Company/armada", branch: "main", clean: true },
  toml: { programRoot: "THE-1982", repository: "The-Vibe-Company/armada" },
  suggested: { id: "armada", name: "armada", repository: "The-Vibe-Company/armada", programRoot: "THE-1982" },
  problems: [],
};
const NO_REMOTE = {
  path: "/Users/owner/Dev/osprey",
  git: { branch: "main", clean: true },
  toml: null,
  suggested: { id: "osprey", name: "osprey" },
  problems: ["Git repository has no readable origin remote"],
};

type Sent = { type: string; id?: string } & Record<string, unknown>;

describe("Add project in a browser", () => {
  let browser: Browser | undefined;
  let page: Page;
  let bundle = "";
  let css = "";

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
    const context = await browser.newContext();
    page = await context.newPage();
    page.setDefaultTimeout(2_000);
    // No network: the page and its script are served here, anything else is refused.
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === ORIGIN && url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html class="dark"><style>${css}</style><body style="margin:0;height:100vh"><div id="root" style="height:100%"></div><script type="module" src="/add.js"></script></body></html>`,
        });
      if (url.href === `${ORIGIN}/add.js`) return route.fulfill({ contentType: "text/javascript", body: bundle });
      return route.abort();
    });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  }, 10_000);

  const receive = (message: Record<string, unknown>) =>
    page.evaluate((m) => (window as unknown as { fake: { receive(m: unknown): void } }).fake.receive(m), message);
  const sent = () => page.evaluate(() => (window as unknown as { fake: { sent: Sent[] } }).fake.sent);
  const pick = (folder: string | null) =>
    page.evaluate((f) => (window as unknown as { fake: { pick(f: string | null): void } }).fake.pick(f), folder);
  /** The last request of this type the client sent, once it sent one. */
  const last = async (type: string): Promise<Sent> => {
    await page.waitForFunction(
      (t) => (window as unknown as { fake: { sent: Sent[] } }).fake.sent.some((m) => m.type === t),
      type,
    );
    return (await sent()).filter((m) => m.type === type).at(-1) as Sent;
  };
  const dialog = () => page.getByRole("dialog");
  const field = (name: string) => dialog().getByLabel(name, { exact: true });
  const button = (name: string) => page.getByRole("button", { name, exact: true });

  /** A fresh page at `at`, its daemon listing these projects. */
  async function open(projects: object[], at = "/") {
    await page.goto(`${ORIGIN}${at}`);
    await page.evaluate(() => (window as unknown as { fake: { open(): void } }).fake.open());
    await receive({ type: "projects.result", id: "r1", projects });
  }

  /** Add project opened from the bar, Browse answered with `folder`, the daemon's inspection `read` arrived. */
  async function inspected(read: object) {
    await page.locator("header").getByRole("button", { name: "Add project" }).click();
    await pick((read as { path: string }).path);
    await dialog().getByRole("button", { name: "Browse…" }).click();
    const inspect = await last("projects.inspect");
    expect(inspect.path).toBe((read as { path: string }).path);
    await receive({ type: "projects.inspection", id: inspect.id, ...read });
    // The form, or the problem that leaves none.
    await field("Name").or(dialog().locator("[data-problems]")).first().waitFor();
  }

  test("the empty hangar invites to add the first project, and its button opens the dialog", async () => {
    await open([]);
    const hero = page.locator("[data-hero]");
    expect(await hero.getByText("No project yet. Add the folder of one.").count()).toBe(1);
    await hero.getByRole("button", { name: "Add project" }).click();
    // A dialog named by its title, the focus on Browse.
    await page.getByRole("dialog", { name: "Add a project" }).waitFor();
    expect(await dialog().getAttribute("aria-modal")).toBe("true");
    await settled(() => page.evaluate(() => document.activeElement?.textContent), "Browse…");
    // Add waits for a folder the daemon read.
    expect(await button("Add").isDisabled()).toBe(true);
  });

  test("Browse inspects the folder, the form reads it, Add sends it and closes on the daemon's answer", async () => {
    await open([KESTREL]);
    await inspected(ARMADA);
    expect(await field("Folder").inputValue()).toBe("/Users/owner/Dev/armada");
    expect(await field("Repository").inputValue()).toBe("The-Vibe-Company/armada");
    expect(await field("Name").inputValue()).toBe("Armada");
    expect(await field("Linear program").inputValue()).toBe("THE-1982");
    // Left empty, the daemon still takes armada.toml's program: the hint says so.
    expect(await dialog().getByText("Empty, armada.toml's THE-1982.", { exact: false }).count()).toBe(1);
    expect(await dialog().locator("[data-problems]").count()).toBe(0);
    await button("Add").click();
    const add = await last("projects.add");
    expect(add).toMatchObject({
      path: "/Users/owner/Dev/armada",
      projectId: "armada",
      name: "Armada",
      repository: "The-Vibe-Company/armada",
      programRoot: "THE-1982",
    });
    const armada = { id: "armada", name: "Armada", repository: "The-Vibe-Company/armada", root: ARMADA.path };
    await receive({ type: "projects.result", id: add.id, projects: [KESTREL, armada] });
    await settled(() => dialog().count(), 0);
    // The project's card: its sidebar line, faded in once; Kestrel was there before.
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    expect(await sidebar.getByRole("link", { name: "Armada" }).getAttribute("data-arrived")).toBe("true");
    expect(await sidebar.getByRole("link", { name: "Kestrel" }).getAttribute("data-arrived")).toBeNull();
    // The focus is back on what opened the dialog.
    await settled(() => page.evaluate(() => document.activeElement?.textContent), "Add project");
  });

  test("a folder without a remote asks for the repository, and Add waits for owner/repo", async () => {
    await open([KESTREL]);
    await inspected(NO_REMOTE);
    const problems = dialog().locator("[data-problems]");
    expect(await problems.innerText()).toBe("No git remote: choose the repository");
    expect(await problems.getAttribute("class")).toContain("text-amber");
    expect(await field("Repository").inputValue()).toBe("");
    await settled(() => page.evaluate(() => document.activeElement?.getAttribute("placeholder")), "owner/repo");
    expect(await field("Linear program").inputValue()).toBe("");
    expect(await button("Add").isDisabled()).toBe(true);
    await field("Repository").fill("osprey");
    expect(await dialog().getByText("As owner/repo, on GitHub.").count()).toBe(1);
    expect(await button("Add").isDisabled()).toBe(true);
    await field("Repository").fill("example/osprey");
    expect(await button("Add").isDisabled()).toBe(false);
    // Enter sends it, without Linear: no program.
    await field("Name").press("Enter");
    const add = await last("projects.add");
    expect(add).toMatchObject({ projectId: "osprey", name: "Osprey", repository: "example/osprey" });
    expect(add.programRoot).toBeUndefined();
  });

  test("a path the daemon cannot open says so, and leaves nothing to add", async () => {
    await open([KESTREL]);
    await inspected({
      path: "/Users/owner/Dev/missing",
      git: null,
      toml: null,
      suggested: { id: "missing", name: "missing" },
      problems: ["Path is not an accessible folder"],
    });
    expect(await dialog().locator("[data-problems]").innerText()).toBe("Path is not an accessible folder");
    expect(await field("Repository").count()).toBe(0);
    expect(await button("Add").isDisabled()).toBe(true);
  });

  test("the daemon's refusal stays under the form, and Escape closes it with the focus back", async () => {
    await open([KESTREL]);
    await inspected(ARMADA);
    await button("Add").click();
    const add = await last("projects.add");
    await receive({
      type: "error",
      id: add.id,
      code: "invalid-message",
      message: "Project root is already registered",
    });
    const alert = dialog().getByRole("alert");
    expect(await alert.innerText()).toBe("Project root is already registered");
    expect(await alert.getAttribute("class")).toContain("text-red");
    expect(await dialog().count()).toBe(1);
    // The focus stays in the dialog: Shift-Tab from its first control goes round to its last, and back.
    await field("Folder").focus();
    await page.keyboard.press("Shift+Tab");
    await settled(() => page.evaluate(() => document.activeElement?.textContent), "Add");
    await page.keyboard.press("Tab");
    await settled(() => page.evaluate(() => document.activeElement?.getAttribute("placeholder")), "Choose a folder");
    await page.keyboard.press("Escape");
    await settled(() => dialog().count(), 0);
    await settled(() => page.evaluate(() => document.activeElement?.textContent), "Add project");
  });

  test("without the desktop's picker, the folder is a field Enter reads", async () => {
    await open([KESTREL], "/?web");
    await button("Add project").click();
    expect(await dialog().getByRole("button", { name: "Browse…" }).count()).toBe(0);
    await field("Folder").fill("~/Dev/armada");
    await field("Folder").press("Enter");
    const inspect = await last("projects.inspect");
    expect(inspect.path).toBe("~/Dev/armada");
    expect((await sent()).some((m) => m.type === "projects.add")).toBe(false);
    await receive({ type: "projects.inspection", id: inspect.id, ...ARMADA });
    expect(await field("Repository").inputValue()).toBe("The-Vibe-Company/armada");
  });

  test("Remove project in a room's rules asks first, shows the in-flight refusal, then goes home", async () => {
    await open([KESTREL], "/#/projects/kestrel?panel=rules");
    await button("Remove project").click();
    expect(await page.getByRole("dialog", { name: "Remove Kestrel?" }).count()).toBe(1);
    expect(await dialog().getByText("Its workers must be stopped first. Its history stays.").count()).toBe(1);
    await dialog().getByRole("button", { name: "Remove" }).click();
    const first = await last("projects.remove");
    expect(first.project).toBe("kestrel");
    await receive({ type: "error", id: first.id, code: "invalid-message", message: "Project has a worker in flight" });
    expect(await dialog().getByRole("alert").innerText()).toBe("Project has a worker in flight");
    await dialog().getByRole("button", { name: "Remove" }).click();
    await page.waitForFunction(
      () =>
        (window as unknown as { fake: { sent: Sent[] } }).fake.sent.filter((m) => m.type === "projects.remove")
          .length === 2,
    );
    const second = (await sent()).filter((m) => m.type === "projects.remove").at(-1) as Sent;
    await receive({ type: "projects.result", id: second.id, projects: [] });
    await settled(() => page.evaluate(() => window.location.hash), "#/");
    await page.locator("[data-hero]").waitFor();
  });
});
