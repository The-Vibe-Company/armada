import { expect, type Page, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

/*
 * The Orchestrators surface against e2e/mock-orchestrators.ts, a stand-in for #647's v1 routes. These tests prove the
 * presentation (what is shown, sent and kept), never the server's policy or runtime: those have their own tests.
 */

const ALICE_ORCHESTRATOR = "00000000-0000-4000-8000-000000000160";
const BOB_ORCHESTRATOR = "00000000-0000-4000-8000-000000000161";
const DETAIL = `/orchestrators/${ALICE_ORCHESTRATOR}`;

type Call = { route: string; body: Record<string, unknown>; key: string | null };

async function testControl(action: string, body: object = {}): Promise<{ calls: Call[] }> {
  const response = await fetch(`${MOCK}/__test/orchestrators/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as { calls: Call[] };
}

const calls = async () => (await testControl("state")).calls;
const messages = (page: Page) => page.getByRole("log", { name: "Messages" });
const composer = (page: Page) => page.getByRole("form", { name: "Message the orchestrator" });

test.beforeEach(reset);

test("the list shows only the viewer's orchestrators, compactly", async ({ page }) => {
  await signIn(page, "alice@example.com", "/orchestrators");
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Orchestrators" }),
  ).toHaveAttribute("aria-current", "page");
  const row = page.getByRole("row").filter({ hasText: "Release coordinator" });
  await expect(row).toContainText("Ready");
  await expect(row).toContainText("Claude Code");
  await expect(row).toContainText("claude-opus-5-5");
  await expect(row).toContainText("Boat");
  await expect(row).toContainText("5 min ago");
  await expect(page.getByText("Bob's private plan")).toHaveCount(0);

  const response = await page.goto(`/orchestrators/${BOB_ORCHESTRATOR}`);
  expect(response?.status()).toBe(404);
});

test("a server with orchestrators turned off says why and offers no form", async ({ page }) => {
  await testControl("feature-off");
  await signIn(page, "alice@example.com", "/orchestrators");
  await expect(page.getByText("Not available here yet")).toBeVisible();
  await expect(page.getByText("until each provider passes its native conformance checks")).toBeVisible();
  await expect(page.getByRole("button", { name: "New orchestrator" })).toHaveCount(0);
  await page.goto(DETAIL);
  await expect(page.getByText("until each provider passes its native conformance checks")).toBeVisible();
  await expect(page.getByRole("form", { name: "Message the orchestrator" })).toHaveCount(0);
});

test("a server without orchestrators says so and offers no form it would refuse", async ({ page }) => {
  await testControl("disable");
  await signIn(page, "alice@example.com", "/orchestrators");
  await expect(page.getByText("Not available here yet")).toBeVisible();
  await expect(page.getByText("This Armada server does not offer orchestrators yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "New orchestrator" })).toHaveCount(0);
});

test("create sends the v1 request with a named account and the server's defaults, then opens the chat", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/orchestrators");
  await page.getByRole("button", { name: "New orchestrator" }).click();
  const dialog = page.getByRole("dialog", { name: "New orchestrator" });
  await expect(dialog.getByLabel("Model account")).toHaveValue("acct-claude");
  await expect(dialog.getByLabel("Stop after inactivity")).toBeHidden();
  await dialog.getByLabel("Agent").selectOption("codex");
  await expect(dialog.getByLabel("Model account")).toHaveValue("acct-codex");
  await dialog.getByLabel("Agent").selectOption("claude");
  await dialog.getByLabel("Name").fill("Docs sweep");
  await dialog.getByLabel("Golden").selectOption({ label: "shared-golden · Boat" });
  await dialog.getByText("Advanced").click();
  await dialog.getByLabel("Working directory").selectOption("api");
  await dialog.getByRole("button", { name: "Create" }).click();

  await page.waitForURL(/\/orchestrators\/00000000-0000-4000-8000-000000000182$/);
  await expect(page.getByRole("heading", { name: "Docs sweep" })).toBeVisible();
  await expect(page.getByText("No conversation yet")).toBeVisible();
  const [create] = await calls();
  expect(create?.route).toBe("create");
  expect(create?.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(create?.body).toMatchObject({
    version: 1,
    name: "Docs sweep",
    provider: "boat",
    harness: "claude",
    repo: "api",
    modelAccountId: "acct-claude",
  });
  expect(create?.body).not.toHaveProperty("idleSeconds");
  expect(create?.body).not.toHaveProperty("maxChildStartsPerDay");
  expect(create?.body).not.toHaveProperty("maxActiveChildren");
});

test("the chat shows the conversation, workers and waits, and sends with the fence", async ({ page }) => {
  await signIn(page, "alice@example.com", DETAIL);
  await expect(messages(page).getByText("Ship issues #12 and #13, one worker each.")).toBeVisible();
  await expect(messages(page).getByText("Launched two workers.")).toBeVisible();
  await expect(page.getByText("Native conversation kept")).toBeVisible();

  const side = page.getByRole("complementary", { name: "Orchestrator details" });
  await side.locator("summary", { hasText: "Workers" }).click();
  await expect(side.getByRole("link", { name: "00000000" })).toHaveAttribute("href", /\/sandboxes\/0{8}-/);
  await side.locator("summary", { hasText: "Waiting on" }).click();
  await expect(side.getByText("CI: CI of #12")).toBeVisible();
  await expect(side.getByText(/token|secret/i)).toHaveCount(0);

  const box = composer(page).getByLabel("Message");
  await box.fill("Also open #14.");
  await box.press("Control+Enter");
  await expect(messages(page).getByText("Also open #14.")).toBeVisible();
  await expect(box).toHaveValue("");
  const [message] = await calls();
  expect(message).toMatchObject({ route: "message", body: { expectedRevision: 3, text: "Also open #14." } });
});

test("a stale revision is refused, refreshed and kept as a draft; the next send is a new request", async ({ page }) => {
  await signIn(page, "alice@example.com", DETAIL);
  await expect(messages(page).getByText("Launched two workers.")).toBeVisible();
  await testControl("bump", { id: ALICE_ORCHESTRATOR });
  const box = composer(page).getByLabel("Message");
  await box.fill("Merge order: #12 first.");
  await composer(page).getByRole("button", { name: "Send" }).click();
  await expect(composer(page).getByRole("alert")).toContainText("changed or is busy");
  await expect(box).toHaveValue("Merge order: #12 first.");

  // The refusal re-reads the orchestrator at once: the next send carries the new revision without retries.
  await composer(page).getByRole("button", { name: "Send" }).click();
  await expect(box).toHaveValue("");
  const sent = (await calls()).filter((call) => call.route === "message");
  expect(sent.at(-1)?.body.expectedRevision).toBe(4);
  expect(new Set(sent.map((call) => call.key)).size).toBe(sent.length);
});

test("an unknown outcome is sent again with the same key and applied once", async ({ page }) => {
  await signIn(page, "alice@example.com", DETAIL);
  await expect(messages(page).getByText("Launched two workers.")).toBeVisible();
  await testControl("fail-next", { status: 503, code: "uncertain", message: "The answer was lost." });
  const box = composer(page).getByLabel("Message");
  await box.fill("Report status.");
  await composer(page).getByRole("button", { name: "Send" }).click();
  await expect(composer(page).getByRole("alert")).toContainText("The answer was lost.");
  await expect(box).toHaveValue("Report status.");
  // The page catches up with the applied message (revision 4) before the retry; the retry still sends revision 3.
  await expect(messages(page).getByText("Report status.")).toBeVisible();
  await composer(page).getByRole("button", { name: "Send again" }).click();
  await expect(box).toHaveValue("");
  const sent = (await calls()).filter((call) => call.route === "message");
  expect(sent).toHaveLength(2);
  expect(sent[1]?.key).toBe(sent[0]?.key ?? "");
  expect(sent[1]?.body).toEqual(sent[0]?.body ?? {});
  await expect(messages(page).getByText("Report status.")).toHaveCount(1);
});

test("stop asks first and keeps the conversation; resume continues the same orchestrator", async ({ page }) => {
  await signIn(page, "alice@example.com", DETAIL);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText("Its worker keeps running")).toBeVisible();
  await page.getByRole("button", { name: "Stop orchestrator" }).click();
  await expect(page.locator("[data-orchestrator-state]")).toHaveText("Stopped");
  await expect(composer(page).getByLabel("Message")).toBeDisabled();
  await expect(composer(page)).toContainText("Resume it to continue the same conversation.");
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.locator("[data-orchestrator-state]")).toHaveText("Ready");
  await expect(page).toHaveURL(new RegExp(`${DETAIL}$`));
  await expect(messages(page).getByText("Launched two workers.")).toBeVisible();
  expect((await calls()).map((call) => call.route)).toEqual(["stop", "resume"]);
});

test("a lost connection shows reconnecting, then catches up from the cursor", async ({ page }) => {
  await signIn(page, "alice@example.com", DETAIL);
  await expect(messages(page).getByText("Launched two workers.")).toBeVisible();
  await testControl("offline");
  // At rest the page reads every 10 seconds.
  await expect(page.getByText("Reconnecting…")).toBeVisible({ timeout: 15_000 });
  await testControl("agent-reply", { id: ALICE_ORCHESTRATOR, text: "Both PRs are green." });
  await testControl("online");
  await expect(messages(page).getByText("Both PRs are green.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Reconnecting…")).toHaveCount(0);
  await expect(messages(page).getByText("Launched two workers.")).toHaveCount(1);
});

test("on a desktop the chat fits the viewport: the history scrolls, the document does not", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, "alice@example.com", DETAIL);
  await expect(messages(page).getByText("Launched two workers.")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(overflow).toBeLessThanOrEqual(1);
  const box = await composer(page).boundingBox();
  expect(box && box.y + box.height).toBeLessThanOrEqual(800);
});

test("on a phone the chat is one screen tall with the composer reachable by keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "alice@example.com", DETAIL);
  await expect(messages(page).getByText("Launched two workers.")).toBeVisible();
  const chat = page.getByTestId("orchestrator-chat");
  const height = (await chat.boundingBox())?.height ?? 0;
  expect(height).toBeLessThanOrEqual(844);
  await composer(page).getByLabel("Message").focus();
  const box = await composer(page).boundingBox();
  const viewportTop = await page.evaluate(() => window.scrollY);
  expect(box && box.y + box.height - viewportTop).toBeLessThanOrEqual(844);
  await page.keyboard.type("From the phone.");
  await page.keyboard.press("Control+Enter");
  await expect(messages(page).getByText("From the phone.")).toBeVisible();
});

test("a lost conversation is explained and never offered as resumable", async ({ page }) => {
  await testControl("patch", { id: ALICE_ORCHESTRATOR, patch: { state: "stopped", continuity: "lost" } });
  await signIn(page, "alice@example.com", DETAIL);
  await expect(page.getByText("The conversation was lost")).toBeVisible();
  await expect(page.getByText("Create a new orchestrator to start over.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume" })).toHaveCount(0);
  await expect(composer(page).getByLabel("Message")).toBeDisabled();
});

test("an unknown create outcome locks the form and tries the same request again, creating one", async ({ page }) => {
  await signIn(page, "alice@example.com", "/orchestrators");
  await testControl("fail-next", { status: 503, code: "uncertain", message: "The answer was lost." });
  await page.getByRole("button", { name: "New orchestrator" }).click();
  const dialog = page.getByRole("dialog", { name: "New orchestrator" });
  await dialog.getByLabel("Name").fill("Night shift");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog.getByRole("alert")).toContainText("The answer was lost.");
  await expect(dialog.getByLabel("Name")).toBeDisabled();
  await dialog.getByRole("button", { name: "Try again" }).click();
  await page.waitForURL(/\/orchestrators\/00000000-0000-4000-8000-000000000182$/);
  const creates = (await calls()).filter((call) => call.route === "create");
  expect(creates).toHaveLength(2);
  expect(creates[1]?.key).toBe(creates[0]?.key ?? "");
  const state = (await testControl("state")) as unknown as { orchestrators: { configuration: { name: string } }[] };
  expect(state.orchestrators.filter((row) => row.configuration.name === "Night shift")).toHaveLength(1);
});

test("an expired dashboard session stops reading and asks to sign in again", async ({ page }) => {
  await signIn(page, "alice@example.com", DETAIL);
  await expect(messages(page).getByText("Launched two workers.")).toBeVisible();
  await page.context().clearCookies();
  // At rest the page reads every 10 seconds.
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Reconnecting…")).toHaveCount(0);
});

test("a receipt whose effect was not confirmed says the orchestrator is held, keeps the draft", async ({ page }) => {
  await signIn(page, "alice@example.com", DETAIL);
  await expect(messages(page).getByText("Launched two workers.")).toBeVisible();
  await testControl("uncertain-next");
  const box = composer(page).getByLabel("Message");
  await box.fill("Merge #12.");
  await composer(page).getByRole("button", { name: "Send" }).click();
  await expect(composer(page).getByRole("alert")).toContainText("held until Armada reconciles it");
  await expect(box).toHaveValue("Merge #12.");
  await expect(page.locator("[data-orchestrator-state]")).toHaveText("Needs attention");
  // While the receipt is unsettled the server refuses every command: none is offered, not even Stop.
  await expect(box).toBeDisabled();
  await expect(box).toHaveAttribute("placeholder", /Armada is settling the last message/);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  const [message] = (await calls()).filter((call) => call.route === "message");
  expect(message?.body).toEqual({
    orgId: "00000000-0000-4000-8000-000000000010",
    expectedRevision: 3,
    text: "Merge #12.",
  });
});

test("a create refused with a bare conflict keeps the form locked on the same request", async ({ page }) => {
  await signIn(page, "alice@example.com", "/orchestrators");
  await testControl("fail-next", { status: 409, code: "conflict", message: "conflict" });
  await page.getByRole("button", { name: "New orchestrator" }).click();
  const dialog = page.getByRole("dialog", { name: "New orchestrator" });
  await dialog.getByLabel("Name").fill("Weekend");
  await dialog.getByLabel("Golden").selectOption({ label: "shared-golden · Boat" });
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog.getByRole("alert")).toContainText("cannot create it twice");
  await expect(dialog.getByLabel("Name")).toBeDisabled();
  await dialog.getByRole("button", { name: "Try again" }).click();
  await page.waitForURL(/\/orchestrators\/00000000-0000-4000-8000-000000000182$/);
  const creates = (await calls()).filter((call) => call.route === "create");
  expect(creates.map((call) => call.key)).toEqual([creates[0]?.key ?? "", creates[0]?.key ?? ""]);
});

test("an open chat stops reading and says why once orchestrators are turned off", async ({ page }) => {
  await signIn(page, "alice@example.com", DETAIL);
  await expect(messages(page).getByText("Launched two workers.")).toBeVisible();
  await testControl("feature-off");
  // At rest the page reads every 10 seconds.
  await expect(page.getByText("until each provider passes its native conformance checks")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Reconnecting…")).toHaveCount(0);
});
