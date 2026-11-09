import { expect, type Page, test } from "@playwright/test";
import { IDS, MOCK, reset, signIn } from "./helpers";

/** A long conversation: enough history that an unbounded page would scroll the document. */
const history = Array.from({ length: 40 }, (_, index) => ({
  id: `h${index}`,
  at: 1_762_596_300_000 + index * 1000,
  kind: "message",
  text: `Step ${index}: checked another parser fixture and its expected output.`,
  partial: false,
  tools: [],
}));

async function overflow(page: Page) {
  return page.evaluate(() => ({
    vertical: document.documentElement.scrollHeight - window.innerHeight,
    horizontal: document.documentElement.scrollWidth - window.innerWidth,
  }));
}

// Layout is measured right after each action: no smooth-scroll animation may still be moving the page.
test.use({ reducedMotion: "reduce" });

test.beforeEach(async () => {
  await reset();
  await fetch(`${MOCK}/__test/sandbox-events`, {
    method: "POST",
    body: JSON.stringify({ sandbox: IDS.running, events: history }),
  });
});

for (const [label, size] of [
  ["desktop", { width: 1280, height: 720 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  test(`${label}: the conversation fits the viewport; only its history scrolls and the composer stays in view`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
    const messages = page.getByRole("log", { name: "Messages" });
    await expect(messages.getByText("Step 39:")).toBeAttached();
    await page.screenshot({ path: `test-results/sandbox-viewport-${label}.png`, animations: "disabled" });
    await expect(messages.getByText("Step 39:")).toBeInViewport();

    expect(await overflow(page)).toEqual({ vertical: 0, horizontal: 0 });
    await expect(page.getByRole("textbox", { name: "Message" })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
    expect(await messages.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

    // The history scrolls on its own and keeps its place; the page does not move.
    await messages.evaluate((element) => element.scrollTo({ top: 0 }));
    await expect(messages.getByText("Step 0:")).toBeInViewport();
    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    // Details stay reachable: a bounded panel beside the conversation, or a compact disclosure on a phone.
    if (label === "mobile") await page.getByRole("button", { name: "Details" }).click();
    const details = page.getByRole("region", { name: "Details" });
    // Opening them brings them into view; nothing else has to be scrolled to find what the tap revealed.
    await expect(details.getByText("Golden", { exact: true })).toBeInViewport();
    const connections = details.getByText("Launched without MCP connections you can see.");
    await connections.scrollIntoViewIfNeeded();
    await expect(connections).toBeInViewport();
    expect(await overflow(page)).toEqual({ vertical: 0, horizontal: 0 });
    await page.screenshot({ path: `test-results/sandbox-viewport-${label}-details.png`, animations: "disabled" });
    // Beside the conversation the composer never moves; on a phone the details follow it and the composer is a scroll away.
    const send = page.getByRole("button", { name: "Send", exact: true });
    if (label === "mobile") await send.scrollIntoViewIfNeeded();
    await expect(send).toBeInViewport({ ratio: 1 });
  });
}

test("the history stays on its newest message when its height changes, and open details never squeeze it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  const messages = page.getByRole("log", { name: "Messages" });
  await expect(messages.getByText("Step 39:")).toBeInViewport();
  const before = await messages.evaluate((element) => element.clientHeight);
  const atLatest = () =>
    messages.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight <= 1);
  // The model panel shrinks the history: it stays pinned to the latest message.
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await expect(page.getByLabel("Reasoning effort")).toBeVisible();
  await expect.poll(atLatest).toBe(true);
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.getByRole("region", { name: "Details" }).getByText("Golden", { exact: true })).toBeVisible();
  expect(await messages.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(before);
  await expect.poll(atLatest).toBe(true);
  expect((await overflow(page)).vertical).toBe(0);
});

test("a history that grows back to its bottom follows new messages again", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  const messages = page.getByRole("log", { name: "Messages" });
  await expect(messages.getByText("Step 39:")).toBeInViewport();
  const model = page.getByRole("button", { name: "Model", exact: true });
  const height = () => messages.evaluate((element) => element.clientHeight);
  const tall = await height();
  await model.click();
  await expect(page.getByLabel("Reasoning effort")).toBeVisible();
  await expect.poll(height).toBeLessThan(tall);
  const growth = tall - (await height());
  // Read just far enough above the latest message that closing the panel brings its bottom back within reach
  // without the browser clamping the scroll (no scroll event: only the resize can tell).
  await messages.evaluate((element, distance) => {
    element.scrollTop = element.scrollHeight - element.clientHeight - distance;
  }, growth + 24);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await model.click();
  await expect.poll(height).toBe(tall);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await fetch(`${MOCK}/__test/append-event`, {
    method: "POST",
    body: JSON.stringify({ sandbox: IDS.running, text: "All tests pass now." }),
  });
  await expect(messages.getByText("All tests pass now.")).toBeInViewport({ timeout: 10_000 });
});

test("on a phone height where it cannot all fit, the composer and its controls are never cut off", async ({ page }) => {
  // A running turn (Steer and Interrupt show) and a technical event, as real sessions have, at an iPhone's height.
  await fetch(`${MOCK}/__test/sandbox-events`, {
    method: "POST",
    body: JSON.stringify({
      sandbox: IDS.running,
      events: [
        { id: "p", at: 1_762_596_300_000, kind: "prompt", text: "Fix the parser", status: "running", promptId: "p" },
        ...history,
        { id: "r", at: 1_762_596_400_000, kind: "other", type: "result", data: {} },
      ],
    }),
  });
  await page.setViewportSize({ width: 390, height: 664 });
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  await expect(page.getByRole("log", { name: "Messages" }).getByText("Step 39:")).toBeAttached();
  for (const open of [false, true]) {
    if (open) await page.getByRole("button", { name: "Details" }).click();
    expect((await overflow(page)).vertical).toBe(0);
    for (const name of ["Message", "Steer", "Interrupt"]) {
      const control =
        name === "Message" ? page.getByRole("textbox", { name }) : page.getByRole("button", { name, exact: true });
      await control.scrollIntoViewIfNeeded();
      // In view after scrolling means no ancestor clips it.
      await expect(control).toBeInViewport({ ratio: 1 });
    }
  }
  await page.screenshot({ path: "test-results/sandbox-viewport-phone-664.png", animations: "disabled" });
});

test("a viewport too short to fit falls back to a scrolling page where nothing is cut off", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  const box = page.getByRole("textbox", { name: "Message" });
  await box.scrollIntoViewIfNeeded();
  await expect(box).toBeInViewport();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
});

test("other dashboard pages keep scrolling the document", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "alice@example.com", "/credentials");
  expect((await overflow(page)).vertical).toBeGreaterThan(0);
});
