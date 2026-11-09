import { expect, type Page, test } from "@playwright/test";
import { IDS, MOCK, reset, signIn } from "./helpers";

const ACME = "00000000-0000-4000-8000-000000000010";
const account = (n: string, kind: string, name: string, isDefault = false) => ({
  id: `00000000-0000-4000-8000-0000000009${n}`,
  kind,
  name,
  isDefault,
  status: "active",
  expiresAt: null,
  updatedAt: "2026-11-10T10:00:00.000Z",
  version: 3,
  createdAt: "2026-11-01T10:00:00.000Z",
});
const WORK = account("01", "claude_oauth", "Work subscription", true);
const API = account("02", "anthropic", "API billing");
const TEAM = account("03", "claude_oauth", "Team plan");
const CODEX = account("04", "openai", "Codex key");

const post = (path: string, body: unknown) =>
  fetch(`${MOCK}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });
/** The seeded running sandbox, as a Modal sandbox launched before accounts were pinned. */
const legacy = (fields: Record<string, unknown> = {}) =>
  post("sandbox-lifecycle", {
    id: IDS.running,
    fields: {
      provider: "modal",
      credential_id: null,
      credential_version: null,
      conversation_ids: ["conv-a"],
      ...fields,
    },
  });
const conversation = () =>
  post("sandbox-events", {
    sandbox: IDS.running,
    events: [
      {
        id: "p1",
        at: 1_762_596_300_000,
        kind: "prompt",
        text: "Migrate the parser",
        status: "finished",
        conversationId: "conv-a",
        promptId: "p1",
      },
      {
        id: "m1",
        at: 1_762_596_310_000,
        kind: "message",
        text: "Migrated. Two fixtures left.",
        partial: false,
        tools: [],
        conversationId: "conv-a",
        promptId: "p1",
      },
    ],
  });
const mockState = async () =>
  (await (await fetch(`${MOCK}/__test/state`)).json()) as {
    bindCalls: Record<string, unknown>[];
    toolCalls: { name: string; args: Record<string, unknown> }[];
    launches: unknown[];
  };
const section = (page: Page) => page.getByRole("region", { name: "Choose this sandbox's account" });

test.beforeEach(reset);

for (const [view, size] of [
  ["desktop", { width: 1280, height: 720 }],
  ["mobile", { width: 390, height: 844 }],
] as const)
  test(`the owner of a legacy Modal sandbox stops it, deliberately binds an account, and the same conversation resumes (${view})`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await legacy();
    await conversation();
    await post("accounts", { user: [WORK, API, CODEX], org: [TEAM] });
    await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
    const choice = section(page);
    await expect(choice.getByRole("radio")).toHaveCount(3);
    await expect(choice.getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(choice.getByText("Codex key")).toHaveCount(0);
    await expect(choice.getByRole("button", { name: "Use this account" })).toHaveCount(0);

    // Sending before a choice is refused by the server with a typed reason; the draft stays.
    const box = page.getByRole("textbox", { name: "Message" });
    await box.fill("Finish the last two fixtures");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator('form p[role="alert"]')).toHaveText(
      "This sandbox needs an account before it can resume. Choose one above.",
    );
    await expect(box).toHaveValue("Finish the last two fixtures");
    await page.screenshot({
      path: `test-results/account-choice-running-${view}.png`,
      fullPage: true,
      animations: "disabled",
    });

    await choice.getByRole("button", { name: "Stop" }).click();
    await page.getByRole("button", { name: "Stop sandbox" }).click();
    await expect(page.locator("h1 + [data-status]")).toHaveAttribute("data-status", "stopped", { timeout: 10_000 });
    const use = choice.getByRole("button", { name: "Use this account" });
    await expect(use).toBeDisabled();
    await choice.getByRole("radio", { name: /Team plan/ }).check();
    await use.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Use Team plan for this sandbox?");
    await expect(dialog).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: `test-results/account-choice-confirm-${view}.png`,
      fullPage: true,
      animations: "disabled",
    });

    await post("fail-next-bind", { status: 503, code: "unavailable", message: "The Armada server is unavailable." });
    await dialog.getByRole("button", { name: "Bind account" }).click();
    await expect(choice.getByRole("alert")).toHaveText("The Armada server is unavailable.");
    await expect(choice.getByRole("radio", { name: /Team plan/ })).toBeChecked();
    await expect(box).toHaveValue("Finish the last two fixtures");

    await use.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Bind account" }).click();
    await expect(choice).toHaveCount(0);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("log", { name: "Messages" }).getByText("Finish the last two fixtures")).toBeVisible();
    await expect(page.locator("h1 + [data-status]")).toHaveAttribute("data-status", "running");

    const { bindCalls, toolCalls, launches } = await mockState();
    expect(bindCalls).toEqual([
      { id: IDS.running, credentialId: TEAM.id, org: ACME },
      { id: IDS.running, credentialId: TEAM.id, org: ACME },
    ]);
    expect(toolCalls.filter((call) => call.name === "send")).toEqual([
      { name: "send", args: { id: IDS.running, prompt: "Finish the last two fixtures", conversation_id: "conv-a" } },
      { name: "send", args: { id: IDS.running, prompt: "Finish the last two fixtures", conversation_id: "conv-a" } },
    ]);
    expect(launches).toEqual([]);
    await page.screenshot({
      path: `test-results/account-choice-resumed-${view}.png`,
      fullPage: true,
      animations: "disabled",
    });
  });

test("a choice that lost a race to another binding says so instead of rebinding", async ({ page }) => {
  await legacy({ status: "stopped" });
  await post("accounts", { user: [WORK, API] });
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  await section(page)
    .getByRole("radio", { name: /API billing/ })
    .check();
  await legacy({ status: "stopped", credential_id: WORK.id, credential_version: 3 });
  await section(page).getByRole("button", { name: "Use this account" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Bind account" }).click();
  await expect(section(page).getByRole("alert")).toHaveText(
    "This sandbox already has an account, or that account just changed. Reload to see it.",
  );
  await page.reload();
  await expect(section(page)).toHaveCount(0);
});

test("only the owner chooses; no usable account points to Credentials; Boat and bound sandboxes are untouched", async ({
  page,
}) => {
  await legacy({ status: "stopped", owner_id: "00000000-0000-4000-8000-000000000002", visibility: "org" });
  await post("accounts", { user: [WORK] });
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  await expect(section(page).getByText("Only its owner can choose the account.")).toBeVisible();
  await expect(section(page).getByRole("radio")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message" }).fill("Pick this up");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator('form p[role="alert"]')).toHaveText(
    "This sandbox needs an account before it can resume. Only its owner can choose it.",
  );

  await legacy({ status: "stopped", owner_id: "00000000-0000-4000-8000-000000000001" });
  await post("accounts", { user: [CODEX] });
  await page.reload();
  await expect(section(page).getByRole("link", { name: "Add one in Credentials" })).toHaveAttribute(
    "href",
    "/credentials",
  );
  // Stopped: its last turn cannot be running any more, so only a resuming Send is offered.
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
    "placeholder",
    "Send a message to resume the sandbox",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/account-choice-none-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 720 });

  await legacy({ status: "stopped", credential_id: WORK.id, credential_version: 3 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Conversation" })).toBeVisible();
  await expect(section(page)).toHaveCount(0);
  // A failed legacy sandbox cannot be stopped and the server never binds it: no doomed choice, no account read.
  await legacy({ status: "failed", credential_id: null, credential_version: null });
  await page.reload();
  await expect(section(page).getByText("It failed, so no account can be bound to it.")).toBeVisible();
  await expect(section(page).getByRole("radio")).toHaveCount(0);
  await page.goto(`/sandboxes/${IDS.failed}`);
  await expect(page.getByRole("heading", { name: "Conversation" })).toBeVisible();
  await expect(section(page)).toHaveCount(0);
  expect((await mockState()).bindCalls).toEqual([]);
});

test("on a short phone the chooser stays inside the viewport, and once bound the conversation fits it again (#629)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await legacy({ status: "stopped" });
  await post("sandbox-events", {
    sandbox: IDS.running,
    events: Array.from({ length: 40 }, (_, index) => ({
      id: `h${index}`,
      at: 1_762_596_300_000 + index * 1000,
      kind: "message",
      text: `Step ${index}: checked another parser fixture.`,
      partial: false,
      tools: [],
      conversationId: "conv-a",
    })),
  });
  await post("accounts", { user: [WORK, API] });
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  const overflow = () =>
    page.evaluate(() => ({
      vertical: document.documentElement.scrollHeight - window.innerHeight,
      horizontal: document.documentElement.scrollWidth - window.innerWidth,
    }));
  const send = page.getByRole("button", { name: "Send", exact: true });
  // The chooser takes room above the conversation; the shell scrolls, the document never does.
  await expect(section(page).getByRole("radio")).toHaveCount(2);
  expect(await overflow()).toEqual({ vertical: 0, horizontal: 0 });
  await send.scrollIntoViewIfNeeded();
  await expect(send).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: "test-results/account-choice-short-mobile.png", animations: "disabled" });

  await section(page)
    .getByRole("radio", { name: /API billing/ })
    .check();
  await section(page).getByRole("button", { name: "Use this account" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Bind account" }).click();
  await expect(section(page)).toHaveCount(0);
  // Bound: the conversation fits the viewport again and only its history scrolls.
  await expect(send).toBeInViewport({ ratio: 1 });
  expect(await overflow()).toEqual({ vertical: 0, horizontal: 0 });
  const messages = page.getByRole("log", { name: "Messages" });
  expect(await messages.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.querySelector("main")?.scrollTop ?? 0)).toBe(0);
  await page.screenshot({ path: "test-results/account-choice-short-mobile-bound.png", animations: "disabled" });
});
