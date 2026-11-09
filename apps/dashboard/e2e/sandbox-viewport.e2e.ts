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
    await details.getByText("MCP connections", { exact: true }).scrollIntoViewIfNeeded();
    await expect(details.getByText("Launched without MCP connections you can see.")).toBeInViewport();
    expect(await overflow(page)).toEqual({ vertical: 0, horizontal: 0 });
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
    await page.screenshot({ path: `test-results/sandbox-viewport-${label}-details.png`, animations: "disabled" });
  });
}

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
