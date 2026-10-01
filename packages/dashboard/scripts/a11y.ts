// The accessibility check (THE-891): WCAG 2.2 AA on every page of the demo
// world, in both languages and both densities, as CI runs it.
//   bun run a11y seed   an owner of an organization, and a member invited to it, in the demo database
//   bun run a11y scan   axe on every page; 320 px without sideways scroll and no motion under
//                       reduced motion; the keyboard's promises (skip link, ⌘K, dialogs, tabs, j/k)
// Seed after `bun run demo:seed` and before the dashboard starts (a PGlite
// database belongs to one process), with the accounts variables the dashboard
// runs with (ARMADA_AUTH_SECRET, ARMADA_AUTH_URL, ARMADA_AUTH_OWNER_EMAILS,
// ARMADA_DATABASE_URL). Without a seed, `scan` reads the pages a shared
// password of `off` opens. ARMADA_A11Y_URL is the dashboard (default
// http://localhost:4822); ARMADA_A11Y_CHROME a Chrome to run, else Playwright's
// "chrome" channel. Every finding is printed, and any fails the run.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { createAuth, type EmailMessage } from "../lib/accounts";
import { accountsModeOf } from "../lib/accounts-settings";
import { openDatabase } from "../lib/db";
import { DENSITIES, DENSITY_COOKIE } from "../lib/fleet-view";
import { LANGUAGE_COOKIE, LANGUAGES } from "../lib/i18n";

const SESSION_FILE = resolve(import.meta.dir, "../.demo/a11y.json");
const OWNER = "olive.owner@example.test";
const MEMBER = "milo.member@example.test";
/** A demo account's password: the demo database holds nothing else. */
const PASSWORD = "a11y-demo-password";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

interface Seeded {
  owner: { name: string; value: string }[];
  member: { name: string; value: string }[];
  invitation: string;
}

const cookiesOf = (res: Response) =>
  res.headers.getSetCookie().map((line) => {
    const [pair = ""] = line.split(";");
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: pair.slice(at + 1) };
  });
const header = (cookies: { name: string; value: string }[]) =>
  new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") });

async function seed() {
  // Better Auth's email sign-up runs outside production only: the dashboard, in production, reads the session it signs.
  const mode = accountsModeOf({ ...process.env, NODE_ENV: "test", ARMADA_AUTH_EMAIL_PASSWORD: "on" });
  if (mode.kind !== "accounts") throw new Error(`set the accounts variables first (${JSON.stringify(mode)})`);
  if (!mode.settings.owners.includes(OWNER)) throw new Error(`ARMADA_AUTH_OWNER_EMAILS must name ${OWNER}`);
  const client = await openDatabase(mode.settings.database);
  const outbox: EmailMessage[] = [];
  const auth = createAuth(mode.settings, { client, sender: { send: async (m) => void outbox.push(m) } });
  const verified = async (email: string, name: string) => {
    await auth.api.signUpEmail({ body: { email, name, password: PASSWORD } });
    const link = outbox.findLast((m) => m.kind === "verification" && m.to === email);
    if (!link) throw new Error(`no verification email for ${email}`);
    return cookiesOf(await auth.handler(new Request(link.url)));
  };
  const owner = await verified(OWNER, "Olive Owner");
  const acme = await auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: header(owner) });
  const invitation = await auth.api.createInvitation({
    body: { email: MEMBER, role: "member", organizationId: acme?.id ?? "" },
    headers: header(owner),
  });
  const member = await verified(MEMBER, "Milo Member");
  await client.end();
  const keep = (list: { name: string; value: string }[]) => list.filter((c) => c.name.endsWith("session_token"));
  const seeded: Seeded = { owner: keep(owner), member: keep(member), invitation: invitation?.id ?? "" };
  await mkdir(dirname(SESSION_FILE), { recursive: true });
  await writeFile(SESSION_FILE, JSON.stringify(seeded));
  console.log(`Seeded ${OWNER} (owner of Acme) and ${MEMBER} (invited) for the accessibility check.`);
}

// ------------------------------------------------------------------ scan

const BASE = (process.env.ARMADA_A11Y_URL ?? "http://localhost:4822").replace(/\/$/, "");
const failures: string[] = [];
const fail = (what: string) => {
  failures.push(what);
  console.log(`  ✗ ${what}`);
};

async function readSeed(): Promise<Seeded | null> {
  try {
    return JSON.parse(await readFile(SESSION_FILE, "utf8")) as Seeded;
  } catch {
    return null;
  }
}

const HOST = new URL(BASE).hostname;
const cookie = (name: string, value: string, secure = false) => ({ name, value, domain: HOST, path: "/", secure });

/** A session cookie, under the name the dashboard reads in development and the one it reads in production. */
const sessionCookies = (list: { name: string; value: string }[]) =>
  list.flatMap((c) => {
    const name = c.name.replace(/^__Secure-/, "");
    return [cookie(name, c.value), cookie(`__Secure-${name}`, c.value, true)];
  });

async function contextFor(
  browser: Browser,
  who: { name: string; value: string }[] | null,
  options: { lang?: string; density?: string; width?: number; reduced?: boolean } = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: 900 },
    reducedMotion: options.reduced ? "reduce" : "no-preference",
  });
  await context.addCookies([
    cookie(LANGUAGE_COOKIE, options.lang ?? "en"),
    cookie(DENSITY_COOKIE, options.density ?? "compact"),
    ...(who ? sessionCookies(who) : []),
  ]);
  return context;
}

/** Opens a page and waits until it has settled: fonts loaded, every animation that ends has ended. */
async function open(page: Page, path: string) {
  const res = await page.goto(`${BASE}${path}`, { waitUntil: "load" });
  if (!res || res.status() >= 400) fail(`${path} answered ${res?.status() ?? "nothing"}`);
  // A page the viewer may not see sends them elsewhere: that would check the wrong page.
  const landed = new URL(page.url()).pathname;
  if (landed !== path.split("?")[0]) fail(`${path} sent the viewer to ${landed}`);
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Entrances on the clock; a scroll-driven one (the landing's) ends only when scrolled, so 2 s at most.
    const ending = document
      .getAnimations()
      .filter((a) => a.timeline === document.timeline && a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY);
    const settled = Promise.all(ending.map((a) => a.finished.catch(() => {})));
    await Promise.race([settled, new Promise((done) => setTimeout(done, 2_000))]);
  });
  // The shell's first poll redraws the page once (times, the live line): let it.
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
}

interface Target {
  path: string;
  who: "owner" | "member" | "none";
}

async function targets(seeded: Seeded | null): Promise<Target[]> {
  const who = seeded ? "owner" : "none";
  const cookie = seeded ? header(sessionCookies(seeded.owner)).get("cookie") : null;
  type Fleet = {
    rows: { id: string }[];
    projects: { slug: string }[];
    validations?: { id: number; decision: unknown }[];
  };
  // A fresh server reads the demo world after its first answer: ask again until it shows.
  let fleet: Fleet = { rows: [], projects: [] };
  for (let tries = 0; tries < 30 && !fleet.rows.length; tries++) {
    if (tries) await Bun.sleep(1_000);
    const res = await fetch(`${BASE}/api/fleet`, { headers: cookie ? { cookie } : {} });
    if (!res.ok) throw new Error(`${BASE}/api/fleet answered ${res.status}: is the demo dashboard running?`);
    fleet = (await res.json()) as Fleet;
  }
  const agent = fleet.rows[0]?.id;
  const project = fleet.projects[0]?.slug;
  const validation = fleet.validations?.find((v) => !v.decision)?.id;
  if (!agent || !project || validation === undefined)
    throw new Error("the demo world has no agent, project or validation");
  const fleetPages = [
    "/",
    "/agents",
    `/agents/${agent}`,
    `/agents/${agent}?tab=files`,
    "/projects",
    `/projects/${project}`,
    "/validations",
    `/approve/${validation}`,
    "/insights",
    "/activity",
    "/activity?kind=merge",
    "/design",
  ];
  return [
    ...fleetPages.map((path) => ({ path, who }) as Target),
    { path: "/landing", who: "none" },
    ...(seeded
      ? ([
          { path: "/organization", who: "owner" },
          { path: "/organization/keys", who: "owner" },
          { path: "/organization/github", who: "owner" },
          { path: "/organization/workers", who: "owner" },
          { path: "/device", who: "owner" },
          { path: "/login", who: "none" },
          { path: "/welcome", who: "member" },
          { path: `/invitations/${seeded.invitation}`, who: "member" },
        ] as Target[])
      : []),
  ];
}

const cookiesFor = (seeded: Seeded | null, who: Target["who"]) => (who === "none" || !seeded ? null : seeded[who]);

async function axe(browser: Browser, seeded: Seeded | null, list: Target[]) {
  console.log("axe: every page, in each language and density");
  for (const lang of LANGUAGES)
    for (const density of DENSITIES)
      for (const who of ["owner", "member", "none"] as const) {
        const mine = list.filter((t) => t.who === who);
        if (!mine.length) continue;
        const context = await contextFor(browser, cookiesFor(seeded, who), { lang, density });
        const page = await context.newPage();
        for (const t of mine) {
          await open(page, t.path);
          const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
          const where = `${t.path} (${lang}, ${density})`;
          if (!result.violations.length) console.log(`  ✓ ${where}`);
          for (const v of result.violations)
            for (const node of v.nodes)
              fail(
                `${where}: ${v.id} (${v.impact}) ${node.target.join(" ")}: ${node.failureSummary?.split("\n")[1]?.trim() ?? v.help}`,
              );
        }
        await context.close();
      }
}

/** 320 px wide (and so 200% zoom of 640 px): no sideways scroll but the timeline's own; no motion when reduced. */
async function reflow(browser: Browser, seeded: Seeded | null, list: Target[]) {
  console.log("320 px, reduced motion");
  for (const who of ["owner", "member", "none"] as const) {
    const mine = list.filter((t) => t.who === who && !t.path.includes("?"));
    if (!mine.length) continue;
    const context = await contextFor(browser, cookiesFor(seeded, who), { width: 320, reduced: true });
    const page = await context.newPage();
    for (const t of mine) {
      await open(page, t.path);
      const { wide, moving } = await page.evaluate(() => ({
        wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        moving: document
          .getAnimations()
          .filter((a) => a.playState === "running")
          .map((a) =>
            a.effect instanceof KeyframeEffect && a.effect.target instanceof Element ? a.effect.target.className : "?",
          ),
      }));
      if (wide > 0) fail(`${t.path} scrolls ${wide} px sideways at 320 px`);
      if (moving.length) fail(`${t.path} still moves under reduced motion: ${[...new Set(moving)].join(", ")}`);
      if (wide <= 0 && !moving.length) console.log(`  ✓ ${t.path}`);
    }
    await context.close();
  }
}

const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el
      ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${el.className}|${el.textContent?.trim() ?? ""}`
      : "";
  });

async function check(what: string, run: () => Promise<boolean>) {
  try {
    if (await run()) console.log(`  ✓ ${what}`);
    else fail(what);
  } catch (e) {
    fail(`${what}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
}

/** The keyboard's promises, on the pages they are made on. */
async function keyboard(browser: Browser, seeded: Seeded | null, list: Target[]) {
  console.log("keyboard");
  const who = seeded ? "owner" : "none";
  const context = await contextFor(browser, cookiesFor(seeded, who));
  const page = await context.newPage();
  const agent = list.find((t) => t.path.startsWith("/agents/"))?.path ?? "/agents";
  const approve = list.find((t) => t.path.startsWith("/approve/"))?.path ?? "/validations";

  await open(page, "/agents");
  await check("the first Tab stop is “Skip to content”, and it moves the focus to the page", async () => {
    await page.keyboard.press("Tab");
    const first = await focused(page);
    await page.keyboard.press("Enter");
    return first.includes("sh-skip") && (await focused(page)).startsWith("main#content");
  });

  await check("⌘K keeps the focus in its field, and Esc gives it back", async () => {
    await page.locator(".sh-search").focus();
    await page.keyboard.press("ControlOrMeta+k");
    await page.locator(".sh-palette input").waitFor();
    await page.keyboard.press("Tab");
    const inside = (await focused(page)).startsWith("input");
    await page.keyboard.press("Escape");
    return inside && (await page.locator(".sh-palette").count()) === 0 && (await focused(page)).includes("sh-search");
  });

  await check("j moves through the rows, Enter opens one, and both stay in a text field", async () => {
    await page.locator(".sh-main").focus();
    await page.keyboard.press("j");
    const moved = (await page.locator("a[data-row][data-selected]").count()) === 1;
    // Enter opens the selected row from the page itself, where "Skip to content" leaves the focus.
    const href = await page.locator("a[data-row][data-selected]").getAttribute("href");
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.pathname === href, { timeout: 5_000 });
    await page.goBack();
    await page.locator(".sh-search").click();
    await page.locator(".sh-palette input").waitFor();
    await page.keyboard.type("jk");
    const typed = (await page.locator(".sh-palette input").inputValue()) === "jk";
    await page.keyboard.press("Escape");
    return moved && typed;
  });

  await open(page, agent);
  await check("the arrows move between tabs", async () => {
    await page.locator(".ui-tab[aria-selected='true']").first().focus();
    const before = await focused(page);
    await page.keyboard.press("ArrowRight");
    const after = await focused(page);
    return after.includes("ui-tab") && after !== before;
  });

  await open(page, "/");
  await check("the timeline scrolls from the keyboard and reads as a table", async () => {
    const scroller = page.locator(".tl-scroll");
    await scroller.focus();
    const start = await scroller.evaluate((el) => el.scrollLeft);
    await page.keyboard.press("ArrowLeft");
    // The browser scrolls smoothly: wait for it to move.
    const scrolled = await page
      .waitForFunction((from) => document.querySelector(".tl-scroll")?.scrollLeft !== from, start, { timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    await page.getByRole("button", { name: "Show as table" }).click();
    const rows = await page.locator(".tl-table tbody tr").count();
    return scrolled && rows > 0;
  });

  await open(page, approve);
  await check("a screenshot's dialog gives the focus back when it closes", async () => {
    const shot = page.locator(".vd-shot").first();
    if (!(await shot.count())) return true;
    await shot.focus();
    await page.keyboard.press("Enter");
    await page.locator("dialog[open]").waitFor();
    await page.keyboard.press("Escape");
    return (await page.locator("dialog[open]").count()) === 0 && (await focused(page)).includes("vd-shot");
  });

  if (seeded) {
    await open(page, "/organization");
    await check("j and k typed in a form's field stay in it", async () => {
      const field = page.locator("input.ui-input:not([type='hidden'])").first();
      await field.focus();
      await page.keyboard.type("jk");
      return (
        (await field.inputValue()).endsWith("jk") && (await page.locator("a[data-row][data-selected]").count()) === 0
      );
    });
    await check("the organization menu closes on Esc and gives the focus back", async () => {
      await page.locator(".sh-org-button").focus();
      await page.keyboard.press("Enter");
      await page.locator("#sh-menu").waitFor();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Escape");
      return (await page.locator("#sh-menu").count()) === 0 && (await focused(page)).includes("sh-org-button");
    });
  }
  await context.close();
}

async function scan() {
  const seeded = await readSeed();
  const list = await targets(seeded);
  const executablePath = process.env.ARMADA_A11Y_CHROME;
  const browser = await chromium.launch(executablePath ? { executablePath } : { channel: "chrome" });
  try {
    await axe(browser, seeded, list);
    await reflow(browser, seeded, list);
    await keyboard(browser, seeded, list);
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.log(`\n${failures.length} accessibility finding(s).`);
    process.exit(1);
  }
  console.log("\nNo accessibility finding.");
}

const [command] = process.argv.slice(2);
if (command === "seed") await seed();
else if (command === "scan") await scan();
else {
  console.error("Usage: bun run a11y seed|scan");
  process.exit(2);
}
