import { expect, test } from "@playwright/test";
import { IDS, LABELS, reset, signIn } from "./helpers";

const TEST_USAGE_REVISION = "test-usage-revision";

test.beforeEach(reset);

function page(status: string, text: string, cursor = "1", hasMore = false) {
  return {
    status,
    usageRevision: TEST_USAGE_REVISION,
    configured: true,
    events: [
      {
        id: `message-${text}`,
        at: 1_762_596_300_000,
        kind: "message",
        text,
        partial: false,
        tools: [],
      },
      // The envelope is valid even when a newer provider event is not understood yet.
      { id: "future-event", at: 1_762_596_300_001, kind: "future-provider-event", payload: {} },
    ],
    cursor,
    hasMore,
  };
}

test("recovers stopped history after a log-lane 502 without consuming its failed page", async ({ page: browser }) => {
  await browser.clock.install();
  const urls: string[] = [];
  let reads = 0;
  await browser.route(`**/api/sandboxes/${IDS.failed}/events*`, async (route) => {
    reads += 1;
    urls.push(route.request().url());
    if (reads === 1) {
      return route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          status: "stopped",
          usageRevision: TEST_USAGE_REVISION,
          configured: true,
          error: "The logs could not be read.",
          // A failed response must never advance to this cursor or display this event.
          events: [{ id: "failed-page", at: 1, kind: "message", text: "failed page" }],
          cursor: "wrong-cursor",
          hasMore: true,
        }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(page("stopped", "Recovered history")),
    });
  });

  await signIn(browser, "alice@example.com", `/sandboxes/${IDS.failed}`);
  await expect(browser.getByRole("log", { name: "Messages" })).toContainText("Recovered history");
  await expect(browser.getByRole("log", { name: "Messages" })).not.toContainText("failed page");
  expect(reads).toBe(2);
  expect(new URL(urls[0] ?? "https://example.test").search).toBe("");
  expect(new URL(urls[1] ?? "https://example.test").search).toBe("");
  await expect(browser.locator('[data-fit="chat"] [data-status]')).toBeVisible();
});

for (const status of [401, 404] as const) {
  test(`stops polling when the sandbox access response is ${status}`, async ({ page: browser }) => {
    await browser.clock.install();
    let reads = 0;
    await browser.route(`**/api/sandboxes/${IDS.running}/events*`, (route) => {
      reads += 1;
      return route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ error: status === 401 ? "Unauthorized." : "Not found." }),
      });
    });

    await signIn(browser, "alice@example.com", `/sandboxes/${IDS.running}`);
    const notice = browser.locator('[data-slot="alert"]').filter({
      hasText: status === 401 ? "session expired" : "no longer available",
    });
    await expect(notice).toBeVisible();
    await expect(browser.getByRole("button", { name: "Retry" })).toBeVisible();
    await browser.clock.runFor(60_000);
    expect(reads).toBe(1);
  });
}

test("retries transport and malformed-page failures without losing the cursor", async ({ page: browser }) => {
  await browser.clock.install();
  const requests: string[] = [];
  let reads = 0;
  await browser.route(`**/api/sandboxes/${IDS.running}/events*`, async (route) => {
    reads += 1;
    requests.push(route.request().url());
    if (reads === 1) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(page("running", "Seed page", "seed-cursor", true)),
      });
    }
    if (reads === 2) return route.abort();
    if (reads === 3) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ nope: true }) });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(page("running", "Recovered after retry")),
    });
  });

  await signIn(browser, "alice@example.com", `/sandboxes/${IDS.running}`);
  const notice = browser.locator('[data-slot="alert"]').filter({ hasText: "Retrying" });
  await expect(notice).toBeVisible();
  await browser.clock.runFor(500);
  await expect(
    browser.locator('[data-slot="alert"]').filter({ hasText: "invalid conversation response" }),
  ).toBeVisible();
  await browser.clock.runFor(1_000);
  await expect(browser.getByRole("log", { name: "Messages" })).toContainText("Recovered after retry");
  await expect(browser.getByRole("log", { name: "Messages" })).toContainText("Seed page");
  expect(reads).toBe(4);
  expect(requests.map((url) => new URL(url).search)).toEqual([
    "",
    "?cursor=seed-cursor",
    "?cursor=seed-cursor",
    "?cursor=seed-cursor",
  ]);
});

test("caps retries and offers a manual retry", async ({ page: browser }) => {
  await browser.clock.install();
  let reads = 0;
  await browser.route(`**/api/sandboxes/${IDS.running}/events*`, async (route) => {
    reads += 1;
    if (reads <= 6) return route.abort();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(page("running", "Manual retry recovered")),
    });
  });

  await signIn(browser, "alice@example.com", `/sandboxes/${IDS.running}`);
  await expect.poll(() => reads).toBe(1);
  for (const [delay, expected] of [
    [500, 2],
    [1_000, 3],
    [2_000, 4],
    [4_000, 5],
    [8_000, 6],
  ] as const) {
    await browser.clock.runFor(delay);
    await expect.poll(() => reads).toBe(expected);
  }
  await expect(
    browser.locator('[data-slot="alert"]').filter({ hasText: "Retry when the server is available" }),
  ).toBeVisible();
  await expect(browser.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(reads).toBe(6);
  await browser.clock.runFor(60_000);
  expect(reads).toBe(6);

  await browser.getByRole("button", { name: "Retry" }).click();
  await expect(browser.getByRole("log", { name: "Messages" })).toContainText("Manual retry recovered");
  expect(reads).toBe(7);
});

test("a held read is aborted on cleanup and cannot block a fresh polling effect", async ({ page: browser }) => {
  await browser.clock.install();
  let reads = 0;
  let aborted = false;
  browser.on("requestfailed", (request) => {
    if (request.url().includes(`/api/sandboxes/${IDS.running}/events`)) aborted = true;
  });
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const startedReading = new Promise<void>((resolve) => {
    started = resolve;
  });
  await browser.route(`**/api/sandboxes/${IDS.running}/events*`, async (route) => {
    reads += 1;
    if (reads === 1) {
      started();
      await held;
      try {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(page("running", "stale response")),
        });
      } catch {
        // Navigation aborts this route; the stale response must not reach the chat.
      }
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(page("running", "fresh response")) });
  });

  await signIn(browser, "alice@example.com", `/sandboxes/${IDS.running}`);
  await startedReading;
  await browser.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Sandboxes" }).click();
  await expect(browser.getByRole("link", { name: LABELS.running })).toBeVisible();
  await expect.poll(() => aborted).toBe(true);
  release();
  await browser.getByRole("link", { name: LABELS.running }).click();
  await browser.waitForURL(`**/sandboxes/${IDS.running}`);
  await expect(browser.getByRole("log", { name: "Messages" })).toContainText("fresh response");
  await expect(browser.getByRole("log", { name: "Messages" })).not.toContainText("stale response");
  expect(reads).toBeGreaterThanOrEqual(2);
});
