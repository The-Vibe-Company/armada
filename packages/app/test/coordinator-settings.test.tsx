import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { type ClientMessage, type ModelsCatalog, PROTOCOL_VERSION } from "@armada/protocol";
import { type Browser, chromium, type Page } from "playwright-core";

// Settings › Coordinator (THE-2070) in Chromium, on the app's own daemon
// client over a fake socket (test/coordinator-settings-page.tsx): the two
// Continue buttons, a sign-in rendered from the daemon's auth frames and
// answered, the model picker over pi's catalog, an API key sent once, each
// project's override read from its rules; no key or answer stays in the page.

const V = PROTOCOL_VERSION;
const ORIGIN = "http://coordinator.test";
type Provider = ModelsCatalog["providers"][number];

const model = (id: string, name: string, reasoning: boolean, contextWindow: number) => ({
  id,
  name,
  reasoning,
  contextWindow,
  inputCost: 0,
  outputCost: 0,
});
const codex = (status: Provider["status"]): Provider => ({
  id: "openai-codex",
  name: "OpenAI Codex",
  auth: { oauth: true, apiKey: false, envVars: [] },
  status,
  models: [model("codex-swift", "Codex Swift", true, 400_000), model("codex-mini", "Codex Mini", false, 128_000)],
});
const claude = (status: Provider["status"]): Provider => ({
  id: "anthropic",
  name: "Anthropic",
  auth: { oauth: true, apiKey: true, envVars: ["ANTHROPIC_API_KEY"] },
  status,
  models: [model("claude-keel", "Claude Keel", true, 200_000)],
});
const mistral = (status: Provider["status"]): Provider => ({
  id: "mistral",
  name: "Mistral",
  auth: { oauth: false, apiKey: true, envVars: ["MISTRAL_API_KEY"] },
  status,
  models: [model("mistral-gale", "Mistral Gale", false, 128_000)],
});
const NOTHING = [codex("unconfigured"), claude("unconfigured"), mistral("unconfigured")];
const PROJECTS = [
  { id: "harbor", name: "Harbor", repository: "example/harbor" },
  { id: "lantern", name: "Lantern", repository: "example/lantern" },
];

describe("Settings › Coordinator in a browser", () => {
  let browser: Browser | undefined;
  let bundle = "";

  // The page's bundle and the headless shell (installed before the suite) are setup, not behaviour deadlines.
  beforeAll(async () => {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "coordinator-settings-page.tsx")],
      target: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!built.success) throw new Error(built.logs.join("\n"));
    bundle = (await built.outputs[0]?.text()) ?? "";
    browser = await chromium.launch({ timeout: 15_000 });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  }, 10_000);

  type Sent = ClientMessage & Record<string, unknown>;
  const sent = (page: Page): Promise<Sent[]> =>
    page.evaluate(() => (window as unknown as { daemon: { sent: Sent[] } }).daemon.sent);
  const all = async (page: Page, type: ClientMessage["type"]) => (await sent(page)).filter((m) => m.type === type);
  const last = async (page: Page, type: ClientMessage["type"]) => {
    const message = (await all(page, type)).at(-1);
    if (!message) throw new Error(`the app sent no ${type}`);
    return message;
  };
  const receive = (page: Page, message: Record<string, unknown>) =>
    page.evaluate(
      (json) => (window as unknown as { daemon: { receive(m: unknown): void } }).daemon.receive(JSON.parse(json)),
      JSON.stringify({ version: V, ...message }),
    );
  const catalog = (page: Page, id: string, providers: Provider[], selected: unknown = null) =>
    receive(page, { type: "models.catalog", id, providers, selected });
  /** What the page holds: its markup and the browser's storage. */
  const held = (page: Page) =>
    page.evaluate(() => JSON.stringify([localStorage, sessionStorage, document.body.innerHTML]));

  /** The page connected to a daemon of the catalog's minor that lists `providers`; Harbor's rules name a model. */
  async function open(providers: Provider[], selected: unknown = null): Promise<Page> {
    if (!browser) throw new Error("browser setup did not complete");
    const context = await browser.newContext();
    const page = await context.newPage();
    // No network: the page and its script are served here, anything else is refused.
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === ORIGIN && url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><div id="root"></div><script type="module" src="/page.js"></script>',
        });
      if (url.href === `${ORIGIN}/page.js`) return route.fulfill({ contentType: "text/javascript", body: bundle });
      return route.abort();
    });
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => "daemon" in window, undefined, { timeout: 5_000 });
    await page.evaluate(() => (window as unknown as { daemon: { open(): void } }).daemon.open());
    await receive(page, { type: "projects.result", id: (await last(page, "projects.list")).id, projects: PROJECTS });
    await receive(page, {
      type: "credentials.result",
      id: (await last(page, "credentials.status")).id,
      provider: null,
      storage: "os-keychain",
    });
    await receive(page, {
      type: "plugins.result",
      id: (await last(page, "plugins.list")).id,
      plugins: [],
      restartable: false,
    });
    for (const subscribe of await all(page, "project.subscribe")) {
      const rules =
        subscribe.project === "harbor"
          ? { revision: 3, value: { coordinatorModel: { provider: "anthropic", model: "claude-keel" } } }
          : { revision: 0, value: {} };
      await receive(page, {
        type: "project.subscribed",
        id: subscribe.id,
        subscriptionId: `s-${subscribe.project}`,
        project: subscribe.project,
        after: 0,
        snapshot: { seq: 0, state: { rules } },
      });
    }
    await catalog(page, (await last(page, "models.providers")).id, providers, selected);
    return page;
  }

  test("nothing connected: Continue with ChatGPT signs in through the browser, answers a choice, then reads Signed in", async () => {
    const page = await open(NOTHING);
    const chatgpt = page.getByRole("button", { name: "Continue with ChatGPT" });
    await chatgpt.waitFor({ timeout: 5_000 });
    expect(await page.getByRole("button", { name: "Continue with Claude" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Sign out" }).count()).toBe(0);

    await chatgpt.click();
    const login = await last(page, "models.login");
    expect(login).toMatchObject({ provider: "openai-codex", authType: "oauth" });
    await page.getByText("Opening your browser…").waitFor();

    const url = "https://auth.example.test/authorize?state=north";
    await receive(page, { type: "auth.event", flow: login.id, event: { type: "auth_url", url } });
    await page.locator("[data-auth-url]").filter({ hasText: url }).waitFor();
    expect(await page.evaluate(() => (window as unknown as { daemon: { opened: string[] } }).daemon.opened)).toEqual([
      url,
    ]);
    expect(await page.getByRole("button", { name: "Copy link" }).count()).toBe(1);

    await receive(page, {
      type: "auth.event",
      flow: login.id,
      event: { type: "device_code", userCode: "WXYZ-1234", verificationUri: "https://auth.example.test/device" },
    });
    await page.locator("[data-device-code]").filter({ hasText: "WXYZ-1234" }).waitFor();

    await receive(page, {
      type: "auth.prompt",
      id: "p1",
      flow: login.id,
      promptType: "select",
      message: "Which workspace?",
      options: [
        { id: "ws-north", label: "North" },
        { id: "ws-south", label: "South" },
      ],
    });
    await page.getByRole("combobox", { name: "Which workspace?" }).selectOption("ws-south");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    expect(await last(page, "auth.answer")).toMatchObject({ flow: login.id, id: "p1", value: "ws-south" });
    expect(await page.getByRole("combobox", { name: "Which workspace?" }).count()).toBe(0);

    // The sign-in ends with the catalog under its own id: the row reads the account's state.
    await catalog(page, login.id, [codex("signed-in"), claude("unconfigured"), mistral("unconfigured")]);
    const row = page.locator('[data-provider="openai-codex"]');
    await row.filter({ hasText: "Signed in" }).waitFor();
    expect(await row.getByRole("button", { name: "Sign out" }).count()).toBe(1);
    expect(await chatgpt.count()).toBe(0);
    expect(await page.locator("[data-sign-in]").count()).toBe(0);

    await row.getByRole("button", { name: "Sign out" }).click();
    expect(await last(page, "models.logout")).toMatchObject({ provider: "openai-codex" });
    await page.context().close();
  });

  test("a secret is sent and never kept; a failure says why in red; Cancel ends the sign-in quietly", async () => {
    const page = await open(NOTHING);
    await page.getByRole("button", { name: "Continue with Claude" }).click();
    const login = await last(page, "models.login");
    expect(login).toMatchObject({ provider: "anthropic", authType: "oauth" });

    const secret = randomBytes(16).toString("hex");
    await receive(page, {
      type: "auth.prompt",
      id: "p2",
      flow: login.id,
      promptType: "secret",
      message: "Your organisation's passphrase",
    });
    const field = page.getByLabel("Your organisation's passphrase");
    expect(await field.getAttribute("type")).toBe("password");
    await field.fill(secret);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    expect(await last(page, "auth.answer")).toMatchObject({ flow: login.id, id: "p2", value: secret });
    expect(await held(page)).not.toContain(secret);

    await receive(page, {
      type: "error",
      id: login.id,
      code: "invalid-message",
      message: "Sign-in failed. Try again.",
    });
    await page.getByRole("alert").filter({ hasText: "Sign-in failed. Try again." }).waitFor();

    await page.getByRole("button", { name: "Try again" }).click();
    const again = await last(page, "models.login");
    expect(again.id).not.toBe(login.id);
    expect(await page.getByRole("alert").count()).toBe(0);
    await page.getByRole("button", { name: "Cancel" }).click();
    const cancel = await last(page, "auth.cancel");
    expect(cancel).toMatchObject({ flow: again.id });
    await receive(page, { type: "error", id: again.id, code: "invalid-message", message: "Sign-in cancelled" });
    await catalog(page, cancel.id, NOTHING);
    expect(await page.locator("[data-sign-in]").count()).toBe(0);
    expect(await page.getByRole("alert").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Continue with Claude" }).isEnabled()).toBe(true);
    await page.context().close();
  });

  test("the picker lists the connected provider's models and the others dimmed; choosing one sends models.select", async () => {
    const page = await open([codex("signed-in"), claude("unconfigured"), mistral("unconfigured")]);
    const picker = page.getByRole("button", { name: "Model: Choose a model" });
    await picker.click();
    const options = page.getByRole("option");
    expect(
      await options.evaluateAll((all) => all.map((o) => [o.textContent, o.getAttribute("aria-disabled")])),
    ).toEqual([
      ["Codex Swiftreasoning400k", "false"],
      ["Codex Mini128k", "false"],
      ["Claude Keelreasoning200k", "true"],
      ["Mistral Gale128k", "true"],
    ]);
    expect(await page.locator('[data-picker-group="anthropic"] [data-reason]').textContent()).toBe("Connect first");

    // A dimmed model is not chosen; the search narrows the list.
    await page.locator('[data-model="anthropic/claude-keel"]').dispatchEvent("click");
    expect(await all(page, "models.select")).toEqual([]);
    await page.getByRole("combobox", { name: "Search models" }).fill("mini");
    expect(await options.count()).toBe(1);
    await page.locator('[data-model="openai-codex/codex-mini"]').click();
    const select = await last(page, "models.select");
    expect(select).toMatchObject({ provider: "openai-codex", model: "codex-mini" });
    expect(await page.getByRole("dialog").count()).toBe(0);

    await catalog(page, select.id, [codex("signed-in"), claude("unconfigured"), mistral("unconfigured")], {
      provider: "openai-codex",
      model: "codex-mini",
    });
    await page.getByRole("button", { name: "Model: Codex Mini" }).click();
    expect(await page.locator('[role="option"][aria-selected="true"]').getAttribute("data-model")).toBe(
      "openai-codex/codex-mini",
    );
    await page.context().close();
  });

  test("an API key is sent once with credentials.set, cleared from its field, and the row then reads Key set", async () => {
    const page = await open(NOTHING);
    await page.getByRole("button", { name: "Or use an API key" }).click();
    const key = randomBytes(24).toString("hex");
    const field = page.getByLabel("Mistral API key");
    await field.fill(key);
    await page.locator('[data-provider="mistral"]').getByRole("button", { name: "Save key" }).click();
    const set = await all(page, "credentials.set");
    expect(set.length).toBe(1);
    expect(set[0]).toMatchObject({ provider: "mistral", key, target: "pi" });
    expect(await field.inputValue()).toBe("");
    expect(await held(page)).not.toContain(key);

    await receive(page, { type: "credentials.result", id: set[0]?.id, provider: null, storage: "os-keychain" });
    await catalog(page, String(set[0]?.id), [codex("unconfigured"), claude("unconfigured"), mistral("key-set")]);
    const row = page.locator('[data-provider="mistral"]').filter({ hasText: "Key set" });
    await row.waitFor();
    expect(await row.getByRole("button", { name: "Remove key" }).count()).toBe(1);
    expect(await all(page, "credentials.set")).toHaveLength(1);
    expect(await held(page)).not.toContain(key);
    await page.context().close();
  });

  test("Per project reads each project's model from its rules, Default otherwise, and points to the room", async () => {
    const page = await open([codex("signed-in"), claude("key-set"), mistral("unconfigured")]);
    const row = page.locator('[data-setting="per-project"]');
    await row.waitFor();
    expect(await row.locator("[data-project-model]").evaluateAll((all) => all.map((li) => li.textContent))).toEqual([
      "HarborClaude Keel",
      "LanternDefault",
    ]);
    expect(await row.textContent()).toContain("Ask the coordinator in the room to change it.");
    // No picker on this row until the app can write a project's rules (THE-2088).
    expect(await row.getByRole("button").count()).toBe(0);
    await page.context().close();
  });
});
