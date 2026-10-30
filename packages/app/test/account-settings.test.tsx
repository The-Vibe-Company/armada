import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Plugin } from "@armada/protocol";
import { type Browser, chromium, type Page } from "playwright-core";
import { initialState } from "../src/protocol/client";
import { conductorNeedsSignIn, linearNeedsSignIn } from "../src/settings/needs-armada";

// Settings' Account (THE-2071) in a browser, on the app's own client over a
// fake daemon: the sign-in's three states, the device code and the page it
// opens, signing out, an expired code and Cancel. Then where the fleet says
// "Sign in to Armada in Settings": the sidebar's dot and a project's room.

const ORIGIN = "http://account.test";
const API = "https://armada.example";
const DEVICE_URL = `${API}/device?user_code=ABCDEFGH`;
const SIGNED_IN = {
  type: "account.result",
  signedIn: true,
  apiUrl: API,
  email: "owner@example.com",
  organization: { name: "Example Fleet", slug: "example-fleet" },
  projects: [
    { slug: "harbor", name: "Harbor" },
    { slug: "lantern", name: "Lantern" },
  ],
  keys: { linear: true, github: false },
};

type Sent = { type: string; id?: string };

describe("the Account section in a browser", () => {
  let browser: Browser | undefined;
  let page: Page;
  let bundle = "";

  beforeAll(async () => {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "account-settings-page.tsx")],
      target: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!built.success) throw new Error(built.logs.join("\n"));
    bundle = (await built.outputs[0]?.text()) ?? "";
    browser = await chromium.launch({ timeout: 15_000 });
    const context = await browser.newContext();
    page = await context.newPage();
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/`)
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><div id="root"></div><script type="module" src="/account.js"></script>',
        });
      if (url === `${ORIGIN}/account.js`) return route.fulfill({ contentType: "text/javascript", body: bundle });
      return route.abort();
    });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  }, 10_000);

  const receive = (message: Record<string, unknown>) =>
    page.evaluate((m) => (window as unknown as { fake: { receive(m: unknown): void } }).fake.receive(m), message);
  const sent = () => page.evaluate(() => (window as unknown as { fake: { sent: Sent[] } }).fake.sent);
  const opened = () => page.evaluate(() => (window as unknown as { fake: { opened: string[] } }).fake.opened);
  const last = async (type: string) => {
    const message = (await sent()).filter((m) => m.type === type).at(-1);
    if (!message) throw new Error(`the client sent no ${type}`);
    return message;
  };
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  /** Nothing the page shows carries a session token (the fake sends none; the app must never draw one). */
  const noToken = async () => expect(await page.content()).not.toContain("armada_");

  /** A fresh page, connected to a daemon with the account protocol and one local project, signed out. */
  beforeEach(async () => {
    await page.goto(`${ORIGIN}/`);
    await page.evaluate(() => (window as unknown as { fake: { open(): void } }).fake.open());
    await receive({
      type: "projects.result",
      id: "r1",
      projects: [{ id: "harbor", name: "Harbor", repository: "example/harbor" }],
    });
    await receive({ type: "account.result", id: (await last("account.status")).id, signedIn: false, apiUrl: API });
    await button("Sign in").waitFor({ timeout: 2_000 });
  }, 10_000);

  /** Sign in clicked and the daemon's device code shown: the login request it answered. */
  async function startSignIn(name = "Sign in") {
    await button(name).click();
    await page.waitForFunction(() =>
      (window as unknown as { fake: { sent: Sent[] } }).fake.sent.some((m) => m.type === "account.login"),
    );
    const login = await last("account.login");
    await receive({
      type: "account.device",
      id: login.id,
      code: "ABCD-EFGH",
      verificationUrl: DEVICE_URL,
      expiresAt: "2026-03-10T09:15:00.000Z",
    });
    return login;
  }

  test("signed out: Sign in, the server, and nothing from Armada", async () => {
    expect(await page.getByText("Workers in Conductor and the organization's keys need it.").count()).toBe(1);
    expect(await page.getByText(API, { exact: true }).count()).toBe(1);
    expect(await page.getByRole("heading", { name: "From Armada" }).count()).toBe(0);
    await noToken();
  });

  test("Sign in shows the code large, opens the device page once, and waits for approval", async () => {
    await startSignIn();
    const code = page.locator("[data-code]");
    await code.waitFor({ timeout: 2_000 });
    expect(await code.textContent()).toBe("ABCD-EFGH");
    expect(await code.getAttribute("class")).toContain("text-title");
    expect(await page.getByText("Waiting for approval…").count()).toBe(1);
    expect(await page.locator(".waiting-pulse").count()).toBe(1);
    expect(await page.getByText(DEVICE_URL, { exact: true }).count()).toBe(1);
    expect(await opened()).toEqual([DEVICE_URL]);
    await button("Open armada.example/device").click();
    expect(await opened()).toEqual([DEVICE_URL, DEVICE_URL]);
    expect(await button("Cancel").count()).toBe(1);
    await noToken();
  });

  test("approved: the email, the organization, the keys and projects Armada provides, and Sign out", async () => {
    const login = await startSignIn();
    await receive({ ...SIGNED_IN, id: login.id });
    await button("Sign out").waitFor({ timeout: 2_000 });
    expect(await page.getByText("owner@example.com", { exact: true }).count()).toBe(1);
    expect(await page.locator("[data-organization]").textContent()).toBe("Example Fleet");
    expect(await page.locator("[data-code]").count()).toBe(0);
    expect(await page.locator('[data-key="linear"] [data-state]').textContent()).toBe("Provided");
    expect(await page.locator('[data-key="github"] [data-state]').textContent()).toBe("Not provided");
    // Harbor is a project of this daemon, Lantern is not.
    expect(await page.locator('[data-project="harbor"]').textContent()).toContain("Linked");
    expect(await page.locator('[data-project="lantern"]').textContent()).toContain("Not on this device");
    await noToken();
  });

  test("Sign out asks first, saying the CLI's sign-in goes too, then sends account.logout", async () => {
    const login = await startSignIn();
    await receive({ ...SIGNED_IN, id: login.id });
    await button("Sign out").click();
    expect(await page.locator("[data-confirm]").textContent()).toBe("This signs out the CLI on this device too.");
    expect((await sent()).some((m) => m.type === "account.logout")).toBe(false);
    await button("Sign out").click();
    const logout = await last("account.logout");
    await receive({ type: "account.result", id: logout.id, signedIn: false, apiUrl: API });
    await button("Sign in").waitFor({ timeout: 2_000 });
    expect(await page.getByText("owner@example.com").count()).toBe(0);
    await noToken();
  });

  test("an expired code says so and offers Sign in again", async () => {
    const login = await startSignIn();
    await page.locator("[data-code]").waitFor({ timeout: 2_000 });
    await receive({ type: "error", id: login.id, code: "expired", message: "Sign-in code expired" });
    await button("Sign in again").waitFor({ timeout: 2_000 });
    expect(await page.getByRole("alert").textContent()).toBe("The code expired");
    expect(await page.locator("[data-code]").count()).toBe(0);
    await startSignIn("Sign in again");
    await page.locator("[data-code]").waitFor({ timeout: 2_000 });
    expect(await page.getByRole("alert").count()).toBe(0);
  });

  test("Cancel stops waiting and sends nothing: never account.logout, which would clear the CLI's sign-in", async () => {
    const login = await startSignIn();
    await page.locator("[data-code]").waitFor({ timeout: 2_000 });
    await button("Cancel").click();
    await button("Sign in").waitFor({ timeout: 2_000 });
    expect(await page.locator("[data-code]").count()).toBe(0);
    expect((await sent()).filter((m) => m.type.startsWith("account.")).map((m) => m.type)).toEqual([
      "account.status",
      "account.login",
    ]);
    // The cancelled login's late end says nothing.
    await receive({ type: "error", id: login.id, code: "expired", message: "Sign-in code expired" });
    expect(await page.getByRole("alert").count()).toBe(0);
    // Signing in again opens the page again.
    await startSignIn();
    await page.locator("[data-code]").waitFor({ timeout: 2_000 });
    expect(await opened()).toEqual([DEVICE_URL, DEVICE_URL]);
  });

  test("a code arriving after Cancel neither shows nor opens its page", async () => {
    await button("Sign in").click();
    await page.getByText("Asking Armada for a code…").waitFor({ timeout: 2_000 });
    await button("Cancel").click();
    const login = await last("account.login");
    await receive({
      type: "account.device",
      id: login.id,
      code: "ABCD-EFGH",
      verificationUrl: DEVICE_URL,
      expiresAt: "2026-03-10T09:15:00.000Z",
    });
    expect(await button("Sign in").count()).toBe(1);
    expect(await page.locator("[data-code]").count()).toBe(0);
    expect(await opened()).toEqual([]);
  });

  test("coming back to the section mid-way shows the code again without opening its page twice", async () => {
    await startSignIn();
    await page.locator("[data-code]").waitFor({ timeout: 2_000 });
    await page.evaluate(() => (window as unknown as { fake: { remount(): void } }).fake.remount());
    expect(await page.locator("[data-code]").textContent()).toBe("ABCD-EFGH");
    expect(await button("Cancel").count()).toBe(1);
    expect(await opened()).toEqual([DEVICE_URL]);
  });
});

const plugin = (
  seam: string,
  kind: string,
  config: unknown,
  secrets: Plugin["contributions"][number]["secrets"] = [],
) =>
  ({
    id: kind,
    version: "1.0.0",
    description: null,
    enabled: true,
    loaded: true,
    restartRequired: false,
    contributions: [{ seam, kind, schema: true, config, secrets }],
  }) as Plugin;
const reading = (signedIn: boolean, plugins: Plugin[]) => ({
  account: signedIn ? { ...SIGNED_IN, signedIn: true as const } : { signedIn: false as const, apiUrl: API },
  plugins: { plugins, restartable: true },
});

test("the sidebar's dot: signed out with a Conductor runtime on, never signed in or without one", () => {
  const conductor = plugin("runtime", "conductor", {});
  expect(conductorNeedsSignIn(reading(false, [conductor]))).toBe(true);
  expect(conductorNeedsSignIn(reading(true, [conductor]))).toBe(false);
  expect(conductorNeedsSignIn(reading(false, [{ ...conductor, enabled: false }]))).toBe(false);
  expect(conductorNeedsSignIn(reading(false, [plugin("runtime", "skiff", {})]))).toBe(false);
  // An older daemon says nothing of the account: no dot.
  expect(conductorNeedsSignIn({ account: initialState.account, plugins: reading(false, [conductor]).plugins })).toBe(
    false,
  );
});

test("a room asks for the sign-in when its Linear tracker has no key and never read it", () => {
  const linear = plugin("tracker", "linear", { projects: { harbor: { programRoot: "HAR-1" } } }, [
    { name: "LINEAR_API_KEY", set: false },
  ]);
  expect(linearNeedsSignIn(reading(false, [linear]), "harbor", undefined)).toBe(true);
  expect(linearNeedsSignIn(reading(true, [linear]), "harbor", undefined)).toBe(false);
  // A key from the daemon's environment read it.
  expect(linearNeedsSignIn(reading(false, [linear]), "harbor", { linear: "2026-03-10T09:00:00.000Z" })).toBe(false);
  // Not a Linear project, or one with its own key.
  expect(linearNeedsSignIn(reading(false, [linear]), "lantern", undefined)).toBe(false);
  const keyed = plugin("tracker", "linear", { projects: { harbor: {} } }, [{ name: "LINEAR_API_KEY", set: true }]);
  expect(linearNeedsSignIn(reading(false, [keyed]), "harbor", undefined)).toBe(false);
});
