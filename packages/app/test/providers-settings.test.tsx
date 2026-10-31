import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Plugin, Provider } from "@armada/protocol";
import { type Browser, chromium, type Page } from "playwright-core";
import {
  agentStatus,
  binaryConfig,
  connectionStatus,
  routesTo,
  runtimeOf,
  versionLabel,
} from "../src/settings/provider-view";

// Settings › Providers and Connections (THE-2075) in a browser, on the app's
// own client over a fake daemon: the agents' cards and their status lines,
// the switch, a card's detail (Status, Display name, Binary path, Routing),
// the sign-in in place from the daemon's auth frames, the Linear and GitHub
// cards, and the Armada card over THE-2071's Account. Plugin ids, plugin
// versions and seams stay out of these pages.

const ORIGIN = "http://providers.test";
const API = "https://armada.example";
const KEY = "lin_api_7Qm2Rk9vXw4Lp8Zt3Hy6";

const agent = (id: string, rest: Partial<Provider>): Provider => ({
  id,
  seam: "agent",
  name: id,
  mark: id,
  state: "disconnected",
  enabled: true,
  config: { binary: id },
  restartRequired: false,
  ...rest,
});
const PROVIDERS: Provider[] = [
  agent("claude", {
    name: "Claude",
    version: "2.1.314",
    state: "connected",
    account: { label: "ada@example.test" },
  }),
  agent("codex", {
    name: "Codex",
    version: "0.166.0",
    state: "connected",
    account: { label: "ada@example.test", plan: "ChatGPT Pro" },
    config: { binary: "/opt/tools/codex" },
  }),
  agent("conductor", { name: "Conductor", restartRequired: true }),
  agent("opencode", { name: "OpenCode", state: "missing", detail: "Install it with npm i -g opencode-ai" }),
  agent("skiff", { name: "Skiff", enabled: false }),
  { ...agent("linear", { name: "Linear" }), seam: "tracker", config: {} },
  {
    ...agent("github", { name: "GitHub", state: "connected", account: { label: "ada-lindqvist" }, detail: "gh" }),
    seam: "forge",
    config: {},
  },
  { ...agent("node-local", { name: "This device", state: "connected" }), seam: "node", config: {} },
  { ...agent("model-anthropic", { name: "Anthropic" }), seam: "model", config: {} },
];
const plugin = (id: string, seam: string, config: Plugin["contributions"][number]["config"] = {}): Plugin => ({
  id,
  version: "9.4.7",
  description: `The ${id} plugin`,
  enabled: id !== "skiff",
  loaded: true,
  restartRequired: id === "conductor",
  contributions: [{ seam, kind: id, schema: true, config, secrets: [] }],
});
const PLUGINS: Plugin[] = [
  plugin("claude", "runtime"),
  plugin("codex", "runtime", { command: "codex", model: "o-7", binary: "/opt/tools/codex" }),
  plugin("conductor", "runtime"),
  plugin("opencode", "runtime"),
  plugin("skiff", "runtime"),
  plugin("linear", "tracker"),
  plugin("github", "forge"),
  plugin("node-local", "node"),
  plugin("model-anthropic", "model"),
];
const RULES = {
  revision: 3,
  value: {
    routing: [
      { labels: ["ui", "web"], cli: "codex", model: "gpt-5.5", effort: "high" },
      { labels: ["api"], cli: "claude", model: "opus" },
      { when: "the ticket touches the docs", cli: "codex", model: "gpt-5.5-mini" },
    ],
    defaultRoute: { cli: "claude", model: "sonnet" },
  },
};

type Sent = { type: string; id?: string; [key: string]: unknown };

describe("the Providers and Connections sections in a browser", () => {
  let browser: Browser | undefined;
  let page: Page;
  let bundle = "";

  beforeAll(async () => {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "providers-settings-page.tsx")],
      target: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!built.success) throw new Error(built.logs.join("\n"));
    bundle = (await built.outputs[0]?.text()) ?? "";
    browser = await chromium.launch({ timeout: 15_000 });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === ORIGIN && url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><div id="root"></div><script type="module" src="/providers.js"></script>',
        });
      if (url.origin === ORIGIN && url.pathname === "/providers.js")
        return route.fulfill({ contentType: "text/javascript", body: bundle });
      return route.abort();
    });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  }, 10_000);

  const receive = (message: Record<string, unknown>) =>
    page.evaluate((m) => (window as unknown as { fake: { receive(m: unknown): void } }).fake.receive(m), message);
  const sent = () => page.evaluate(() => (window as unknown as { fake: { sent: Sent[] } }).fake.sent);
  const last = async (type: string) => {
    await page.waitForFunction(
      (t) => (window as unknown as { fake: { sent: Sent[] } }).fake.sent.some((m) => m.type === t),
      type,
    );
    const message = (await sent()).filter((m) => m.type === type).at(-1);
    if (!message) throw new Error(`the client sent no ${type}`);
    return message;
  };
  const card = (id: string) => page.locator(`[data-card="${id}"]`);
  const detail = (id: string) => page.locator(`[data-detail="${id}"]`);
  const text = () => page.evaluate(() => document.body.innerText);
  /** A switch flipped as a click does (this page has no stylesheet: Base UI's switch has no size to click). */
  const flip = (name: string) => page.getByRole("switch", { name }).evaluate((s) => (s as HTMLElement).click());
  /** Nothing the page shows or holds carries the key the owner typed. */
  const noKey = async () => {
    expect(await page.content()).not.toContain(KEY);
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(KEY);
  };

  /** A fresh page on `hash`, connected to a daemon with providers, one project with routing rules, and an account. */
  async function open(hash: string, account: Record<string, unknown> = { signedIn: false, apiUrl: API }) {
    // A new document each time (a hash alone would keep the last one).
    await page.goto("about:blank");
    await page.goto(`${ORIGIN}/${hash}`);
    await page.evaluate(() => (window as unknown as { fake: { open(): void } }).fake.open());
    await receive({
      type: "projects.result",
      id: "r1",
      projects: [{ id: "harbor", name: "Harbor", repository: "example/harbor" }],
    });
    const subscribe = await last("project.subscribe");
    await receive({
      type: "project.subscribed",
      id: subscribe.id,
      subscriptionId: "sub-1",
      project: "harbor",
      after: 0,
      snapshot: { seq: 0, state: { rules: RULES } },
    });
    await receive({ type: "account.result", id: (await last("account.status")).id, ...account });
    await receive({ type: "plugins.result", id: (await last("plugins.list")).id, plugins: PLUGINS, restartable: true });
    await receive({ type: "providers.catalog", id: (await last("providers.list")).id, providers: PROVIDERS });
  }

  beforeEach(async () => {
    await open("#/settings/providers");
    await card("codex").waitFor({ timeout: 2_000 });
  }, 10_000);

  test("one card per agent, in the daemon's order, each with its version and status line, and no plugin vocabulary", async () => {
    const cards = await page
      .locator("[data-card]")
      .evaluateAll((all) =>
        all.map((c) => [
          (c as HTMLElement).dataset.card,
          c.querySelector("[data-card-name]")?.textContent,
          c.querySelector("[data-card-version]")?.textContent ?? null,
          c.querySelector("[data-card-status]")?.textContent,
          c.querySelector("[data-mark]")?.getAttribute("data-mark"),
          c.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
        ]),
      );
    expect(cards).toEqual([
      ["claude", "Claude", "v2.1.314", "Authenticated as ada@example.test", "anthropic", "true"],
      ["codex", "Codex", "v0.166.0", "Authenticated · ChatGPT Pro", "openai", "true"],
      ["conductor", "Conductor", null, "Not signed in · Restart to apply", "generic", "true"],
      ["opencode", "OpenCode", null, "Not installed · Install it with npm i -g opencode-ai", "opencode", "true"],
      ["skiff", "Skiff", null, "Not signed in", "generic", "false"],
    ]);
    // A change waits for the restart: the notice says so, in words without "plugin".
    expect(await page.locator("[data-restart-notice]").innerText()).toContain(
      "One setting changed since the daemon started.",
    );
    expect(await page.locator("[data-add-provider] button").isDisabled()).toBe(true);
    for (const words of [/plugin/i, /\bLoaded\b/, /9\.4\.7/, /runtime\./, /tracker\./, /Anthropic/, /This device/])
      expect(await text()).not.toMatch(words);
    // The nav's groups, Providers current; the breadcrumb and the way back.
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    expect(await nav.locator("[data-nav-group]").allTextContents()).toEqual(["Agents", "Connections"]);
    expect(await nav.locator("a > span:not([aria-hidden])").allTextContents()).toEqual([
      "Coordinator",
      "Providers",
      "Linear",
      "GitHub",
      "Armada",
      "About",
    ]);
    expect(await nav.getByRole("link", { name: "Providers" }).getAttribute("aria-current")).toBe("page");
    expect(await page.getByRole("navigation", { name: "Settings breadcrumb" }).innerText()).toMatch(
      /Settings\s*\/\s*Providers/,
    );
    expect(await page.getByRole("link", { name: "Close settings" }).getAttribute("href")).toBe("#/");
  });

  test("the switch sends plugins.enable and plugins.disable; turning on a signed-out agent opens it on Sign in", async () => {
    await flip("Enable Codex");
    expect(await last("plugins.disable")).toMatchObject({ plugin: "codex" });
    await flip("Enable Skiff");
    const enable = await last("plugins.enable");
    expect(enable).toMatchObject({ plugin: "skiff" });
    await receive({ type: "plugins.result", id: enable.id, plugins: PLUGINS, restartable: true });
    // The daemon lists its providers again after a switch: Skiff on, waiting for the restart.
    await receive({
      type: "providers.catalog",
      id: "push:2",
      providers: PROVIDERS.map((p) => (p.id === "skiff" ? { ...p, enabled: true, restartRequired: true } : p)),
    });
    await page.waitForURL(/#\/settings\/providers\/skiff$/, { timeout: 2_000 });
    await detail("skiff").waitFor({ timeout: 2_000 });
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Sign in");
  });

  test("a click or Enter opens a card's detail below the list, Escape closes it and gives the card the focus", async () => {
    await card("codex").getByRole("button", { expanded: false }).click();
    await page.waitForURL(/#\/settings\/providers\/codex$/, { timeout: 2_000 });
    const codex = detail("codex");
    await codex.waitFor({ timeout: 2_000 });
    expect(await codex.locator("h2").allTextContents()).toEqual(["Codex", "Runtime", "Routing2"]);
    expect(await codex.locator('[data-row="status"]').innerText()).toContain("Authenticated · ChatGPT Pro");
    expect(await codex.getByRole("button", { name: "Sign out" }).count()).toBe(1);
    expect(await codex.getByLabel("Binary path").inputValue()).toBe("/opt/tools/codex");
    // Its routing, from the project's rules: labels, a condition, read-only, linked to the Rules tab.
    expect(await codex.locator("[data-route]").allInnerTexts()).toEqual([
      expect.stringMatching(/ui\s*web\s*Harbor\s*gpt-5\.5 · high/),
      expect.stringMatching(/the ticket touches the docs\s*Harbor\s*gpt-5\.5-mini/),
    ]);
    expect(await codex.getByRole("link", { name: "Harbor" }).first().getAttribute("href")).toBe(
      "#/projects/harbor?panel=rules",
    );

    await page.keyboard.press("Escape");
    await page.waitForURL(/#\/settings\/providers$/, { timeout: 2_000 });
    await codex.waitFor({ state: "detached", timeout: 2_000 });
    expect(
      await card("codex")
        .getByRole("button", { expanded: false })
        .evaluate((b) => b === document.activeElement),
    ).toBe(true);
    await page.keyboard.press("Enter");
    await detail("codex").waitFor({ timeout: 2_000 });
  });

  test("Sign in sends providers.connect and shows the page, the device code, the terminal and the prompt in place", async () => {
    await page.goto(`${ORIGIN}/#/settings/providers/conductor`);
    await detail("conductor").getByRole("button", { name: "Sign in" }).click();
    const connect = await last("providers.connect");
    expect(connect).toMatchObject({ provider: "conductor" });
    const flow = connect.id;
    const event = (e: Record<string, unknown>) => receive({ type: "auth.event", flow, event: e });
    await event({ type: "auth_url", url: "https://auth.example.test/authorize?client=x" });
    await event({ type: "device_code", userCode: "QX7R-2KD9", verificationUri: "https://auth.example.test/device" });
    await event({ type: "terminal", output: "\u001b[1m! First copy your one-time code\u001b[0m\r\n" });
    await event({ type: "terminal", output: "Waiting for the browser...\r\n" });
    await receive({ type: "auth.prompt", id: "p1", flow, promptType: "secret", message: "Paste the token" });
    const panel = page.locator('[data-sign-in="conductor"]');
    expect(await panel.locator("[data-auth-url]").getAttribute("href")).toBe(
      "https://auth.example.test/authorize?client=x",
    );
    expect(await panel.getByRole("button", { name: "Copy link" }).count()).toBe(1);
    expect(await panel.locator("[data-device-code]").textContent()).toBe("QX7R-2KD9");
    expect(await panel.locator("[data-auth-terminal]").textContent()).toBe(
      "! First copy your one-time code\r\nWaiting for the browser...\r\n",
    );
    expect(await page.evaluate(() => (window as unknown as { fake: { opened: string[] } }).fake.opened)).toEqual([
      "https://auth.example.test/authorize?client=x",
    ]);
    // The secret prompt: masked, sent with providers.answer, cleared before it leaves.
    const field = panel.locator('[data-auth-prompt="secret"] input');
    expect(await field.getAttribute("type")).toBe("password");
    await field.fill(KEY);
    await panel.getByRole("button", { name: "Continue" }).click();
    expect(await last("providers.answer")).toMatchObject({ flow, id: "p1", value: KEY });
    await noKey();
    // Signed in: the catalog that answers the connect ends the flow, and the card says so.
    const signedIn = PROVIDERS.map((p) =>
      p.id === "conductor" ? { ...p, state: "connected" as const, account: { label: "ada@example.test" } } : p,
    );
    await receive({ type: "providers.catalog", id: flow, providers: signedIn });
    await panel.waitFor({ state: "detached", timeout: 2_000 });
    expect(await card("conductor").locator("[data-card-status]").textContent()).toContain(
      "Authenticated as ada@example.test",
    );
  });

  test("Cancel sends providers.cancel; a refusal shows its line with Try again", async () => {
    await page.goto(`${ORIGIN}/#/settings/providers/conductor`);
    await detail("conductor").getByRole("button", { name: "Sign in" }).click();
    const first = await last("providers.connect");
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(await last("providers.cancel")).toMatchObject({ flow: first.id });
    await receive({ type: "providers.catalog", id: (await last("providers.cancel")).id, providers: PROVIDERS });
    await receive({ type: "error", id: first.id, code: "invalid-message", message: "Sign-in cancelled" });
    await detail("conductor").getByRole("button", { name: "Sign in" }).click();
    const second = await last("providers.connect");
    expect(second.id).not.toBe(first.id);
    await receive({
      type: "error",
      id: second.id,
      code: "invalid-message",
      message: "Restart Armada to use this provider",
    });
    await page
      .getByRole("alert")
      .filter({ hasText: "Restart Armada to use this provider" })
      .waitFor({ timeout: 2_000 });
    expect(await page.getByRole("button", { name: "Try again" }).count()).toBe(1);
  });

  test("Sign out sends providers.disconnect; the binary path saves with plugins.configure, keeping the rest", async () => {
    await page.goto(`${ORIGIN}/#/settings/providers/codex`);
    const codex = detail("codex");
    await codex.getByRole("button", { name: "Sign out" }).click();
    expect(await last("providers.disconnect")).toMatchObject({ provider: "codex" });
    await codex.getByLabel("Binary path").fill("/usr/local/bin/codex-next");
    await codex.getByRole("button", { name: "Save" }).click();
    expect(await last("plugins.configure")).toMatchObject({
      plugin: "codex",
      seam: "runtime",
      kind: "codex",
      config: { command: "codex", model: "o-7", binary: "/usr/local/bin/codex-next" },
    });
  });

  test("the display name stays in this browser and names the agent on its card and in the room's rows", async () => {
    expect(await page.locator("[data-harness]").textContent()).toBe("Codex");
    await page.goto(`${ORIGIN}/#/settings/providers/codex`);
    const field = detail("codex").getByLabel("Display name");
    expect(await field.getAttribute("placeholder")).toBe("Codex");
    await field.fill("Codex (fast lane)");
    await field.press("Enter");
    await card("codex")
      .locator("[data-card-name]")
      .filter({ hasText: "Codex (fast lane)" })
      .waitFor({ timeout: 2_000 });
    expect(await page.locator("[data-harness]").textContent()).toBe("Codex (fast lane)");
    expect(await page.evaluate(() => localStorage.getItem("armada.displayName.codex"))).toBe("Codex (fast lane)");
    expect((await sent()).some((m) => JSON.stringify(m).includes("fast lane"))).toBe(false);
    await page.evaluate(() => localStorage.clear());
  });

  test("Connections: Linear connects in one click through its key prompt, GitHub shows its account and disconnects", async () => {
    await open("#/settings/connections");
    await card("linear").waitFor({ timeout: 2_000 });
    expect(
      await page
        .locator("[data-card]")
        .evaluateAll((all) => all.map((c) => c.querySelector("[data-card-status]")?.textContent)),
    ).toEqual(["Not connected", "Connected as ada-lindqvist · gh CLI", "Not signed in"]);
    await card("linear").getByRole("button", { name: "Connect", exact: true }).click();
    const connect = await last("providers.connect");
    expect(connect).toMatchObject({ provider: "linear" });
    await page.waitForURL(/#\/settings\/connections\/linear$/, { timeout: 2_000 });
    await receive({ type: "auth.prompt", id: "k1", flow: connect.id, promptType: "secret", message: "Linear API key" });
    const field = detail("linear").locator('[data-auth-prompt="secret"] input');
    await field.fill(KEY);
    await field.press("Enter");
    expect(await last("providers.answer")).toMatchObject({ flow: connect.id, id: "k1", value: KEY });
    await noKey();

    await card("github").getByRole("button", { name: "Disconnect GitHub" }).click();
    expect(await last("providers.disconnect")).toMatchObject({ provider: "github" });
    for (const words of [/plugin/i, /tracker/, /forge/]) expect(await text()).not.toMatch(words);
    expect(
      await page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("link", { name: "Linear" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  test("GitHub's sign-in shows its terminal; Linear offers Armada's key when the account provides one", async () => {
    await open("#/settings/connections/github", {
      signedIn: true,
      apiUrl: API,
      email: "ada@example.test",
      organization: { name: "Example Fleet", slug: "example-fleet" },
      projects: [],
      keys: { linear: true, github: false },
    });
    const disconnected = PROVIDERS.map((p) =>
      p.id === "github" ? { ...p, state: "disconnected" as const, account: undefined } : p,
    );
    await receive({ type: "providers.catalog", id: "push:1", providers: disconnected });
    await detail("github").getByRole("button", { name: "Connect", exact: true }).click();
    const connect = await last("providers.connect");
    await receive({
      type: "auth.event",
      flow: connect.id,
      event: { type: "terminal", output: "✓ Logged in as ada-lindqvist\n" },
    });
    expect(await detail("github").locator("[data-auth-terminal]").textContent()).toBe("✓ Logged in as ada-lindqvist\n");
    await receive({ type: "providers.catalog", id: connect.id, providers: PROVIDERS });

    await card("linear").getByRole("button", { name: "Use Armada's key" }).click();
    expect(await last("providers.connect")).toMatchObject({ provider: "linear" });
    expect(await card("armada").locator("[data-card-status]").textContent()).toBe(
      "Signed in as ada@example.test · Example Fleet",
    );
  });

  test("the Armada card: its detail is the Account section; Sign in from the card asks for the code at once", async () => {
    await open("#/settings/account");
    // The old address is replaced by the Armada card's.
    await page.waitForURL(/#\/settings\/connections\/armada$/, { timeout: 2_000 });
    await detail("armada")
      .getByText("Workers in Conductor and the organization's keys need it.")
      .waitFor({ timeout: 2_000 });
    await page.goto(`${ORIGIN}/#/settings/connections`);
    await card("armada").getByRole("button", { name: "Sign in" }).click();
    const login = await last("account.login");
    await receive({
      type: "account.device",
      id: login.id,
      code: "ABCD-EFGH",
      verificationUrl: `${API}/device?user_code=ABCDEFGH`,
      expiresAt: "2026-03-10T09:15:00.000Z",
    });
    expect(await detail("armada").locator("[data-code]").textContent()).toBe("ABCD-EFGH");
    expect(await page.content()).not.toContain("armada_");
  });
});

describe("the cards' rules", () => {
  test("a status line from the state and the account; a version as the card reads it", () => {
    const [claude, codex, conductor, opencode] = PROVIDERS;
    expect([claude, codex, conductor, opencode].map((p) => p && agentStatus(p).word)).toEqual([
      "Authenticated as ada@example.test",
      "Authenticated · ChatGPT Pro",
      "Not signed in",
      "Not installed",
    ]);
    expect(connectionStatus(undefined).word).toBe("Not available in this build");
    expect(connectionStatus(PROVIDERS.find((p) => p.id === "github"))).toMatchObject({
      word: "Connected as ada-lindqvist",
      detail: "gh CLI",
    });
    expect([
      versionLabel("0.166.0"),
      versionLabel("codex-cli 0.1"),
      versionLabel(" "),
      versionLabel(undefined),
    ]).toEqual(["v0.166.0", "codex-cli 0.1", null, null]);
  });

  test("the binary path keeps the saved config, and an empty one returns to the agent's own command", () => {
    const codex = PLUGINS.find((p) => p.id === "codex") as Plugin;
    expect(runtimeOf(PROVIDERS[1] as Provider, PLUGINS)).toEqual({ plugin: "codex", kind: "codex" });
    expect(runtimeOf({ ...(PROVIDERS[1] as Provider), mark: "elsewhere" }, PLUGINS)).toBeNull();
    expect(binaryConfig(codex, "codex", "  ")).toEqual({ command: "codex", model: "o-7" });
  });

  test("the routes to an agent: its project's labels and conditions in order, then the default route", () => {
    const projects = [
      { id: "harbor", name: "Harbor" },
      { id: "lantern", name: "Lantern" },
    ];
    const fleets = { harbor: { state: { rules: RULES } }, lantern: { state: { rules: { revision: 0 } } } };
    expect(routesTo("claude", projects, fleets)).toEqual([
      { project: "harbor", projectName: "Harbor", labels: ["api"], when: null, model: "opus", effort: null },
      { project: "harbor", projectName: "Harbor", labels: null, when: null, model: "sonnet", effort: null },
    ]);
    expect(routesTo("opencode", projects, fleets)).toEqual([]);
  });
});
