import { expect, test } from "@playwright/test";
import { IDS, LABELS, MOCK, openLaunch, reset, signIn } from "./helpers";

test.beforeEach(reset);

test("the list shows every sandbox of the organization and filters them", async ({ page }) => {
  await signIn(page, "alice@example.com");
  await expect(page.getByRole("link", { name: LABELS.running })).toBeVisible();
  await expect(page.getByRole("link", { name: LABELS.failed })).toBeVisible();
  // An admin opens another member's sandbox, whatever its legacy visibility (#680).
  await expect(page.getByRole("link", { name: LABELS.bobSecret })).toBeVisible();
  // The golden is not in the listed metadata (#680).
  await expect(page.getByRole("columnheader", { name: "Golden" })).toHaveCount(0);

  // Each row names its persisted provider beside the provider's mark, in a column or, on a phone, under the ID (#645).
  const row = (name: string) => page.getByRole("row").filter({ has: page.getByRole("link", { name }) });
  await expect(row(LABELS.running).getByRole("cell", { name: "Boat", exact: true })).toBeVisible();
  await expect(row(LABELS.failed).getByRole("cell", { name: "Modal", exact: true })).toBeVisible();
  await expect(row(LABELS.failed).locator("[data-provider-mark]").filter({ visible: true })).toHaveCount(1);
  await expect(row(LABELS.failed).getByRole("cell", { name: "Large", exact: true })).toBeVisible();
  await expect(row(LABELS.running).getByRole("cell", { name: "Not recorded", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/sandbox-providers-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row(LABELS.failed).getByText("Modal", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(row(LABELS.running).getByText("Boat", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(row(LABELS.running).locator("[data-provider-mark]").filter({ visible: true })).toHaveCount(1);
  await page.screenshot({ path: "test-results/sandbox-providers-mobile.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole("button", { name: "Harness", exact: true }).click();
  await page.getByRole("option", { name: /Codex/ }).click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/harness=codex/);
  await expect(page.getByRole("link", { name: LABELS.failed })).toBeVisible();
  await expect(page.getByText(LABELS.running)).toHaveCount(0);

  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(page).toHaveURL(/\/sandboxes$/);
  await page.getByRole("button", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: /Running/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: LABELS.running })).toBeVisible();
  await expect(page.getByText(LABELS.failed)).toHaveCount(0);
  // OR within status; reload and history preserve the shared view.
  await page
    .getByRole("button", { name: /^Status/ })
    .first()
    .click();
  await page.getByRole("option", { name: /Failed/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: LABELS.failed })).toBeVisible();
  await page.getByLabel("Sort sandboxes").selectOption("oldest");
  await page.reload();
  await expect(page.getByLabel("Sort sandboxes")).toHaveValue("oldest");
  await expect(page.getByRole("button", { name: "Remove Status: Running" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Status: Failed" })).toBeVisible();
  await page.getByLabel("Search sandboxes").fill("not-a-sandbox");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("No sandbox matches these filters")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("link", { name: LABELS.running })).toBeVisible();
  await page.getByRole("button", { name: `Actions for ${LABELS.running}` }).click();
  await expect(page.getByRole("menuitem", { name: "Open sandbox" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("a member sees every sandbox's metadata but opens only their own", async ({ page }) => {
  await signIn(page, "bob@example.com");
  // Bob's own sandbox, launched private before #680, is his to open.
  await expect(page.getByRole("link", { name: LABELS.bobSecret })).toBeVisible();
  // Alice's sandboxes are listed with their metadata, quietly, without a way in.
  const restricted = page.locator("[data-restricted]").filter({ hasText: LABELS.running });
  await expect(restricted).toBeVisible();
  await expect(page.getByRole("link", { name: LABELS.running })).toHaveCount(0);
  await expect(page.getByRole("link", { name: LABELS.failed })).toHaveCount(0);
  const row = page.getByRole("row").filter({ has: restricted });
  await expect(row.getByRole("cell", { name: "alice@example.com" })).toBeVisible();
  await expect(row.getByRole("cell", { name: "Boat", exact: true })).toBeVisible();
  await expect(row.locator("time").first()).toHaveAttribute("datetime", "2026-11-08T10:05:00.000Z");
  await page.screenshot({ path: "test-results/sandbox-access-member-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(restricted).toBeVisible();
  await page.screenshot({
    path: "test-results/sandbox-access-member-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 720 });

  // Going to its address directly: the server refuses the interior, and the page says so without reading any of it.
  await page.goto(`/sandboxes/${IDS.running}`);
  await expect(page.getByRole("heading", { name: LABELS.running })).toBeVisible();
  await expect(page.locator("[data-restricted]")).toContainText("Only its owner and organization admins");
  await expect(page.locator("dl")).toContainText("alice@example.com");
  await expect(page.getByText("Fix the failing test")).toHaveCount(0);
  await expect(page.getByRole("log", { name: "Messages" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  const state = (await (await fetch(`${MOCK}/__test/state`)).json()) as { controlCalls: { operation: string }[] };
  expect(state.controlCalls.filter((call) => call.operation === "sandbox-connections")).toEqual([]);
  await page.screenshot({ path: "test-results/sandbox-access-denied-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/sandbox-access-denied-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("a sandbox the selected organization does not list is not found, even one of the viewer's other org", async ({
  page,
}) => {
  await fetch(`${MOCK}/__test/reset`, { method: "POST", body: JSON.stringify({ multiOrg: true }) });
  await signIn(page, "alice@example.com");
  // Acme is selected; Carol's sandbox is listed to Alice only in Zenith, where she may not open it. Outside the selected
  // organization it is not found, not shown as restricted.
  const response = await page.goto(`/sandboxes/${IDS.zenithCarol}`);
  expect(response?.status()).toBe(404);
});

test("a page past the last one is empty, with a way back", async ({ page }) => {
  await signIn(page, "alice@example.com");
  await page.goto("/sandboxes?page=99");
  await expect(page.getByText("This page is past the last one")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Pages" })).toHaveCount(0);
  await page.getByRole("link", { name: "Go to the first page" }).click();
  await expect(page.getByRole("link", { name: LABELS.running })).toBeVisible();
});

test("the logs of a running sandbox refresh without reloading the page", async ({ page }) => {
  await signIn(page, "alice@example.com");
  await page.getByRole("link", { name: LABELS.running }).click();
  await expect(page.getByRole("heading", { name: "bx_alice_running" })).toBeVisible();
  await expect(page.getByText("Fix the failing test")).toBeVisible();
  await expect(page.getByText("Looking at the test suite.")).toBeVisible();
  await expect(page.getByTestId("live-indicator")).toBeVisible();

  await fetch(`${MOCK}/__test/append-event`, {
    method: "POST",
    body: JSON.stringify({ sandbox: IDS.running, text: "All tests pass now." }),
  });
  await expect(page.getByRole("log", { name: "Messages" }).getByText("All tests pass now.")).toBeVisible({
    timeout: 10_000,
  });
});

test("a usage limit is explained in plain words", async ({ page }) => {
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.failed}`);
  await expect(page.getByText("Usage limit reached")).toBeVisible();
  await expect(page.getByText("hit its plan or billing limit")).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage subscriptions" })).toBeVisible();
});

test("stopping a sandbox asks first, then stops it", async ({ page }) => {
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText("Stop this sandbox?")).toBeVisible();
  await page.getByRole("button", { name: "Stop sandbox" }).click();
  // The dialog closed on confirm: the result is a toast, announced politely (Radix's announcer lives about a second).
  await expect(page.getByRole("status").filter({ hasText: "Stop requested." })).toHaveCount(1);
  await expect(page.locator("h1 + [data-status]")).toHaveAttribute("data-status", "stopped", { timeout: 10_000 });
  // It does not take focus, and is dismissed from the keyboard.
  const toast = page.locator('[data-slot="toast"][data-tone="success"]');
  await expect(toast).toContainText("Stop requested. The machine is removed and the disk is kept.");
  expect(await page.evaluate(() => document.activeElement?.closest('[data-slot="toast"]') ?? null)).toBeNull();
  await page.screenshot({ path: "test-results/toast-stop-desktop.png", animations: "disabled" });
  await page.keyboard.press("F8");
  await expect(page.locator('[data-slot="toast-viewport"]')).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(toast).toHaveCount(0);
  // The conversation shows the same state in the same paint, read at once rather than after its next poll (#627).
  const conversation = page.getByRole("heading", { name: "Conversation" }).locator("xpath=ancestor::div[2]");
  expect(await conversation.locator("[data-status]").getAttribute("data-status")).toBe("stopped");
  await page.screenshot({ path: "test-results/conversation-status-after-stop-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/conversation-status-after-stop-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 720 });
});

const at = (seconds: number) => 1_762_596_300_000 + seconds * 1000;

async function sandboxState(fields: Record<string, unknown>, events: Record<string, unknown>[]) {
  await fetch(`${MOCK}/__test/sandbox-lifecycle`, {
    method: "POST",
    body: JSON.stringify({ id: IDS.running, fields }),
  });
  await fetch(`${MOCK}/__test/sandbox-events`, {
    method: "POST",
    body: JSON.stringify({ sandbox: IDS.running, events }),
  });
}

async function toolCalls() {
  const state = (await (await fetch(`${MOCK}/__test/state`)).json()) as {
    toolCalls: { name: string; args: unknown }[];
  };
  return state.toolCalls;
}

/** Two conversations; the latest streamed one answer in chunks, ran a failing tool and left a technical event. */
const CHAT = [
  {
    id: "a1",
    at: at(0),
    kind: "prompt",
    text: "Write the release notes",
    status: "finished",
    conversationId: "conv-a",
    promptId: "pa",
  },
  {
    id: "a2",
    at: at(5),
    kind: "message",
    text: "Release notes are drafted.",
    partial: false,
    tools: [],
    conversationId: "conv-a",
    promptId: "pa",
  },
  {
    id: "b1",
    at: at(10),
    kind: "prompt",
    text: "Fix the failing parser test",
    status: "running",
    conversationId: "conv-b",
    promptId: "pb",
  },
  {
    id: "b2",
    at: at(11),
    kind: "message",
    text: "",
    partial: true,
    tools: [{ id: "tool-1", name: "Bash", input: {} }],
    conversationId: "conv-b",
    promptId: "pb",
    messageId: "mb0",
    textMode: "delta",
  },
  {
    id: "b3",
    at: at(12),
    kind: "message",
    text: "",
    partial: false,
    tools: [{ id: "tool-1", name: "Bash", input: { command: "bun test parser" } }],
    conversationId: "conv-b",
    promptId: "pb",
    messageId: "mb0",
    textMode: "snapshot",
  },
  {
    id: "b4",
    at: at(13),
    kind: "message",
    text: "",
    partial: false,
    tools: [
      {
        id: "tool-1",
        name: "tool_result",
        result: { output: [{ type: "text", text: "1 fail: expected 3, got 2" }], isError: true },
      },
    ],
    conversationId: "conv-b",
    promptId: "pb",
  },
  {
    id: "b5",
    at: at(14),
    kind: "message",
    text: "The parser drops ",
    partial: true,
    tools: [],
    conversationId: "conv-b",
    promptId: "pb",
    messageId: "mb1",
    textMode: "delta",
  },
  {
    id: "b6",
    at: at(15),
    kind: "message",
    text: "the last token.",
    partial: true,
    tools: [],
    conversationId: "conv-b",
    promptId: "pb",
    messageId: "mb1",
    textMode: "delta",
  },
  {
    id: "b7",
    at: at(16),
    kind: "message",
    text: "The parser drops the last token. Fix:\n\n```ts\nreturn tokens.slice(0, end + 1);\n```\n\nSee [the docs](https://example.com/parser) and [this](javascript:alert(1)).",
    partial: false,
    model: "claude-opus-5-5",
    tools: [],
    conversationId: "conv-b",
    promptId: "pb",
    messageId: "mb1",
    textMode: "snapshot",
  },
  { id: "b8", at: at(17), kind: "other", type: "rate_limits", data: { remaining: 12 }, conversationId: "conv-b" },
];

test("the conversation reads as a chat: one answer per message, tools expand, technical events stay aside", async ({
  page,
}) => {
  await sandboxState({ conversation_ids: ["conv-a", "conv-b"] }, CHAT);
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  const messages = page.getByRole("log", { name: "Messages" });
  await expect(messages.getByText("Fix the failing parser test")).toBeVisible();
  // Streamed chunks and the final text are one message, shown once.
  await expect(messages.getByText(/The parser drops the last token/)).toHaveCount(1);
  await expect(messages.getByText("return tokens.slice(0, end + 1);")).toBeVisible();
  await expect(messages.getByRole("link", { name: "the docs" })).toHaveAttribute("href", "https://example.com/parser");
  await expect(messages.getByRole("link", { name: "this" })).toHaveCount(0);
  await expect(messages.getByText("Release notes are drafted.")).toHaveCount(0);

  const tool = messages.getByRole("button", { name: /Bash.*bun test parser/ });
  await expect(tool).toHaveAttribute("aria-expanded", "false");
  await expect(messages.locator('[data-tool="Bash"]')).toHaveAttribute("data-tool-state", "error");
  await tool.click();
  await expect(tool).toHaveAttribute("aria-expanded", "true");
  await expect(messages.getByText("1 fail: expected 3, got 2")).toBeVisible();
  await page.getByText("Technical events (1)").click();
  await expect(page.getByRole("list", { name: "Technical events" }).getByText("rate_limits")).toBeVisible();
  await page.screenshot({ path: "test-results/sandbox-chat-desktop.png", fullPage: true, animations: "disabled" });

  await page.getByRole("combobox", { name: "Conversation" }).selectOption("conv-a");
  await expect(messages.getByText("Release notes are drafted.")).toBeVisible();
  await expect(messages.getByText("Fix the failing parser test")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("combobox", { name: "Conversation" }).selectOption("conv-b");
  await expect(messages.getByText("Fix the failing parser test")).toBeVisible();
  await page.screenshot({ path: "test-results/sandbox-chat-mobile.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("steer, interrupt and send go to the chosen conversation, and a refused message keeps its draft", async ({
  page,
}) => {
  await sandboxState({ conversation_ids: ["conv-a", "conv-b"] }, CHAT);
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  const box = page.getByRole("textbox", { name: "Message" });
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeVisible();

  await fetch(`${MOCK}/__test/fail-next-tool`, {
    method: "POST",
    body: JSON.stringify({ message: "No turn is running." }),
  });
  await box.fill("Keep the old behaviour for empty input");
  await page.getByRole("button", { name: "Steer", exact: true }).click();
  await expect(page.locator('form p[role="alert"]')).toHaveText("No turn is running.");
  await expect(box).toHaveValue("Keep the old behaviour for empty input");

  await box.press("Control+Enter");
  await expect(page.locator('form p[role="status"]')).toHaveText("Steered.");
  await expect(box).toHaveValue("");
  await expect(
    page.getByRole("log", { name: "Messages" }).getByText("Keep the old behaviour for empty input"),
  ).toBeVisible();

  // A model change is a new turn: it cannot ride on a steer.
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await page.getByLabel("Reasoning effort").selectOption("high");
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeDisabled();
  await box.fill("Then add a regression test");
  await page.getByRole("button", { name: "Send as new turn" }).click();
  await expect(box).toHaveValue("");

  await page.getByRole("button", { name: "Interrupt" }).click();
  await expect(page.getByRole("log", { name: "Messages" }).getByText("Interrupted")).toBeVisible();

  expect(await toolCalls()).toEqual([
    {
      name: "steer",
      args: { id: IDS.running, text: "Keep the old behaviour for empty input", conversation_id: "conv-b" },
    },
    {
      name: "steer",
      args: { id: IDS.running, text: "Keep the old behaviour for empty input", conversation_id: "conv-b" },
    },
    {
      name: "send",
      args: {
        id: IDS.running,
        prompt: "Then add a regression test",
        conversation_id: "conv-b",
        reasoning_effort: "high",
      },
    },
    { name: "interrupt", args: { id: IDS.running, conversation_id: "conv-b" } },
  ]);
});

test("a first message to an idle sandbox starts its turn without a reload", async ({ page }) => {
  await sandboxState({ status: "ready", conversation_ids: [] }, []);
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  await expect(page.getByText("No messages yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message" }).fill("Also update the changelog");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const messages = page.getByRole("log", { name: "Messages" });
  await expect(messages.getByText("Also update the changelog")).toBeVisible();
  await expect(page.locator("h1 + [data-status]")).toHaveAttribute("data-status", "running");
  await expect(page.getByRole("button", { name: "Interrupt" })).toBeVisible();
  await expect(page.getByTestId("agent-working")).toBeVisible();
  expect(await toolCalls()).toEqual([{ name: "send", args: { id: IDS.running, prompt: "Also update the changelog" } }]);
});

test("reading the history is never interrupted by new messages, and the latest is one click away", async ({ page }) => {
  const history = Array.from({ length: 40 }, (_, index) => ({
    id: `h${index}`,
    at: at(index),
    kind: "message",
    text: `Step ${index}: checked another file of the parser and its fixtures.`,
    partial: false,
    tools: [],
  }));
  await sandboxState({}, history);
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  const messages = page.getByRole("log", { name: "Messages" });
  await expect(messages.getByText("Step 39:")).toBeInViewport();
  await messages.evaluate((element) => element.scrollTo({ top: 0 }));
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();

  await fetch(`${MOCK}/__test/append-event`, {
    method: "POST",
    body: JSON.stringify({ sandbox: IDS.running, text: "All tests pass now." }),
  });
  await expect(page.getByRole("button", { name: "New messages" })).toBeVisible({ timeout: 10_000 });
  expect(await messages.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(messages.getByText("Step 0:")).toBeInViewport();

  await page.getByRole("button", { name: "New messages" }).click();
  await expect(messages.getByText("All tests pass now.")).toBeInViewport();
  await expect(page.getByRole("button", { name: /New messages|Jump to latest/ })).toHaveCount(0);
});

test("a launch from a golden sends the chosen model and effort, and a send can override them once", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/environments");
  await page.getByRole("button", { name: "Launch from shared-golden" }).click();
  await page.screenshot({ path: "test-results/launch-model-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("dialog")).toBeInViewport();
  await page.screenshot({ path: "test-results/launch-model-mobile.png", animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByLabel("Model")).toHaveValue("claude-opus-5-5");
  await expect(page.getByLabel("Reasoning effort")).toHaveValue("medium");
  // Repository context of a multi-repo golden: default first, reset when the dialog is reopened.
  const repo = page.getByLabel("Project");
  await expect(repo).toHaveValue("");
  await expect(repo.locator("option")).toHaveText(["Default directory", "web", "api"]);
  await repo.selectOption("web");
  await page.getByRole("radio", { name: "Codex" }).check();
  await page.keyboard.press("Escape");
  await openLaunch(page, "shared-golden");
  await expect(page.getByLabel("Project")).toHaveValue("");
  await expect(page.getByRole("radio", { name: "Claude Code" })).toBeChecked();
  await page.getByLabel("Project").selectOption("api");
  // Switching the agent selects that agent's own defaults, and the summary follows.
  const summary = page.locator("[data-launch-summary]");
  await expect(summary).toHaveText("Claude Opus 5.5 · Medium · 1 MCP");
  await page.getByRole("radio", { name: "Codex" }).check();
  await expect(page.getByLabel("Model")).toHaveValue("gpt-6.1-sol");
  await expect(summary).toHaveText("GPT-6.1 Sol · Medium · 1 MCP");
  await page.getByLabel("Model").selectOption("gpt-6-luna");
  await expect(page.getByLabel("Reasoning effort").locator("option[value=ultra]")).toHaveCount(0);
  await page.getByLabel("Reasoning effort").selectOption("high");
  await page.getByRole("button", { name: "Launch", exact: true }).click();

  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  await expect(page.getByText("gpt-6-luna")).toBeVisible();
  const facts = page.locator("dl").first();
  await expect(facts.getByText("Repository context")).toBeVisible();
  await expect(facts.getByText("api", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("Now the docs");
  await page.getByLabel("Reasoning effort").selectOption("low");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");

  await expect(page.getByLabel("Reasoning effort")).toHaveValue("");
  await page.getByLabel("Model").selectOption("gpt-6-luna");
  await expect(page.getByLabel("Reasoning effort").locator('option[value=""]')).toHaveText("As launched");
  await page.getByLabel("Model").selectOption("gpt-6.1-terra");
  await expect(page.getByLabel("Reasoning effort")).toHaveValue("");
  await expect(page.getByLabel("Reasoning effort").locator('option[value=""]')).toHaveText(
    "Default for selected model (medium)",
  );
  await page.getByRole("textbox", { name: "Message" }).fill("Continue with model default");
  await page.getByRole("button", { name: "Send as new turn" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");

  const { launches, toolCalls } = (await (await fetch(`${MOCK}/__test/state`)).json()) as {
    launches: Record<string, unknown>[];
    toolCalls: { name: string; args: Record<string, unknown> }[];
  };
  // The canonical POST /api/v1/sandbox/launch body.
  expect(launches).toEqual([
    {
      golden: "shared-golden",
      provider: "boat",
      org: expect.any(String),
      harness: "codex",
      model: "gpt-6-luna",
      reasoningEffort: "high",
      // Untouched connections are not sent: the server applies the defaults (#681).
      repo: "api",
    },
  ]);
  // The first send opened a conversation; the next one names it.
  expect(toolCalls).toEqual([
    { name: "send", args: { id: expect.any(String), prompt: "Now the docs", reasoning_effort: "low" } },
    {
      name: "send",
      args: {
        id: expect.any(String),
        prompt: "Continue with model default",
        conversation_id: expect.any(String),
        model: "gpt-6.1-terra",
      },
    },
  ]);
});

test("a sandbox's lifetime is a quiet fact, and a missed deadline is a notice, never a stopped status", async ({
  page,
}) => {
  const lifecycle = (fields: Record<string, unknown>) =>
    fetch(`${MOCK}/__test/sandbox-lifecycle`, { method: "POST", body: JSON.stringify({ id: IDS.running, fields }) });
  await lifecycle({
    expires_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
    effective_ttl_seconds: 8 * 3600,
    requested_ttl_seconds: null,
    last_observed_at: new Date().toISOString(),
    lifecycle_error: null,
  });
  await signIn(page, "alice@example.com");
  await expect(page.locator('[data-lifecycle="remaining"]')).toHaveText(/^1 h \d+ min left$/);
  await page.getByRole("link", { name: LABELS.running }).click();
  const facts = page.locator("dl").first();
  await expect(facts.getByText("8 h (default)")).toBeVisible();
  await expect(facts.getByText("Last checked")).toBeVisible();
  await expect(page.locator("[data-lifecycle-notice]")).toHaveCount(0);

  await lifecycle({
    expires_at: new Date(Date.now() - 600_000).toISOString(),
    lifecycle_error: "The provider did not answer the stop request.",
  });
  await page.reload();
  const notice = page.locator('[data-lifecycle-notice="retrying"]');
  await expect(notice).toContainText("The provider did not answer the stop request.");
  await expect(notice).toContainText("only once the provider confirms");
  await expect(page.locator("h1 + [data-status]")).toHaveAttribute("data-status", "running");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/sandbox-lifecycle-mobile.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
  // The list's metadata carries the deadline but never the stop failure itself (#680): it says the deadline passed.
  await page.goto("/sandboxes");
  await expect(page.locator('[data-lifecycle="overdue"]')).toHaveText("Past deadline");
});

for (const [timezoneId, zone] of [
  ["Europe/Paris", "Nov 8, 2026, 11:05 AM GMT+1 (Europe/Paris)"],
  ["America/Los_Angeles", "Nov 8, 2026, 2:05 AM PST (America/Los_Angeles)"],
] as const) {
  test.describe(timezoneId, () => {
    test.use({ timezoneId });

    test("the list says how long ago a sandbox was created, exact in the viewer's zone", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
      // bx_alice_running was created at 10:05 UTC; the browser's clock is fixed, the server's is not.
      await page.clock.install({ time: new Date("2026-11-08T10:09:00Z") });
      await signIn(page, "alice@example.com");
      // Signing in navigates on the client; a reload renders the list on the server and hydrates it.
      await page.reload();
      await page.clock.pauseAt(new Date("2026-11-08T10:10:00Z"));
      await page.clock.runFor(30_000);

      const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: LABELS.running }) });
      const created = row.locator("time").first();
      await expect(created).toHaveAttribute("datetime", "2026-11-08T10:05:00.000Z");
      await expect(created).toHaveText("5 min ago");
      await page.clock.runFor("02:00");
      await expect(created).toHaveText("7 min ago");

      // Keyboard focus shows the exact time in the browser's zone, and describes the trigger to assistive technology.
      const trigger = row.getByRole("button", { name: "7 min ago" });
      await trigger.focus();
      const tooltip = page.getByRole("tooltip");
      await expect(tooltip).toHaveText(zone);
      await expect(trigger).toHaveAttribute("aria-describedby", /.+/);
      const shot = `test-results/sandbox-created-${timezoneId.replace("/", "-")}`;
      await page.screenshot({ path: `${shot}-desktop.png`, animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(tooltip).toHaveCount(0);

      // So does the pointer.
      await page.getByRole("link", { name: LABELS.running }).focus();
      await trigger.hover();
      await page.clock.runFor(1_000);
      await expect(tooltip).toHaveText(zone);
      await page.mouse.move(0, 0, { steps: 5 });
      await page.clock.runFor(1_000);
      await expect(tooltip).toHaveCount(0);
      // A phone uses a full-width identity and a compact owner/age footer.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole("link", { name: LABELS.running })).toBeVisible();
      await expect(created).toBeHidden();
      await expect(row.locator("time").last()).toBeVisible();
      await page.screenshot({ path: `${shot}-mobile.png`, fullPage: true, animations: "disabled" });

      expect(errors.filter((text) => /hydrat|#418|#423|#425/i.test(text))).toEqual([]);
    });
  });
}
