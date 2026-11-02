import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ChatItem, ModelsCatalog } from "@armada/protocol";
import { type Browser, chromium, type Page } from "playwright-core";
import { isPickerKey } from "../src/room/ComposerModel";
import { type RoomNote, withNotes } from "../src/room/chat";
import { modelLine, roomModel } from "../src/room/model";
import { pickerGroups } from "../src/settings/models";
import { settled } from "./room-browser";

// The coordinator's model from the chat bar (THE-2128): the room's rules for
// which model applies and what a choice edits, then the room in Chromium on a
// fake daemon: the label opens Settings' picker, a choice switches the label
// and the room says so in its own line; during a turn the choice waits for the
// next one; a project with its own model edits that one.

const T0 = "2026-03-10T15:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
type Provider = ModelsCatalog["providers"][number];
const provider = (id: string, status: Provider["status"], models: string[]): Provider => ({
  id,
  name: id,
  auth: { oauth: true, apiKey: true, envVars: [] },
  status,
  models: models.map((m) => ({
    id: m,
    name: m.toUpperCase(),
    reasoning: false,
    contextWindow: 0,
    inputCost: 0,
    outputCost: 0,
  })),
});
const catalog = {
  providers: [provider("anthropic", "signed-in", ["keel", "skiff"]), provider("groq", "unconfigured", ["dory"])],
  selected: { provider: "anthropic", model: "keel" },
};
const ruled = (coordinatorModel: unknown) => ({ rules: { revision: 1, value: { coordinatorModel } } });

test("the room's model is the project's own, else the shared one, else the model plugins'; a project's own needs minor 24", () => {
  const shared = roomModel({ catalog, credentials: null, minor: 24 }, {});
  expect(shared).toEqual({
    label: "KEEL",
    selected: { provider: "anthropic", model: "keel" },
    scope: "shared",
    changeable: true,
  });
  const own = roomModel({ catalog, credentials: null, minor: 24 }, ruled({ provider: "anthropic", model: "skiff" }));
  expect(own).toEqual({
    label: "SKIFF",
    selected: { provider: "anthropic", model: "skiff" },
    scope: "project",
    changeable: true,
  });
  // An older daemon cannot edit a project's own model: the label stays a label.
  expect(
    roomModel({ catalog, credentials: null, minor: 23 }, ruled({ provider: "anthropic", model: "skiff" })).changeable,
  ).toBe(false);
  // Without pi's catalog, the saved plugin model is read as before, and nothing opens.
  const legacy = roomModel(
    {
      catalog: null,
      credentials: { provider: "openai-compatible", config: { model: "harbor-7b" } } as never,
      minor: 8,
    },
    {},
  );
  expect(legacy).toMatchObject({ label: "harbor-7b", changeable: false });
  // No model known: no label, nothing to open.
  expect(roomModel({ catalog: { ...catalog, selected: null }, credentials: null, minor: 24 }, {})).toMatchObject({
    label: null,
    changeable: false,
  });
  expect(modelLine("anthropic", "skiff")).toBe("Coordinator now on anthropic/skiff");
});

test("the room's picker lists a provider not connected as Settings does, with the room's hint; ⌘⇧M and Ctrl+Shift+M open it", () => {
  const groups = pickerGroups(catalog.providers, "", "Connect in Settings");
  expect(groups.map((g) => [g.provider.id, g.available, g.reason])).toEqual([
    ["anthropic", true, null],
    ["groq", false, "Connect in Settings"],
  ]);
  expect(pickerGroups(catalog.providers).at(-1)?.reason).toBe("Connect first");
  const key = { key: "M", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false };
  expect(isPickerKey(key)).toBe(true);
  expect(isPickerKey({ ...key, metaKey: false, ctrlKey: true, key: "m" })).toBe(true);
  expect(isPickerKey({ ...key, shiftKey: false })).toBe(false);
  expect(isPickerKey({ ...key, altKey: true })).toBe(false);
});

test("a room line goes before the first item said after it", () => {
  const items: ChatItem[] = [
    { kind: "owner", id: "a", at: at(0), body: "one" },
    { kind: "coordinator", id: "b", at: at(10), body: "two" },
  ];
  const note = (id: string, seconds: number): RoomNote => ({ kind: "note", id, at: at(seconds), body: id });
  expect(withNotes(items, [note("n1", 5), note("n2", 20)]).map((i) => i.id)).toEqual(["a", "n1", "b", "n2"]);
  expect(withNotes(items, [])).toBe(items);
});

const ORIGIN = "http://room-model.test";

describe("the coordinator's model changes from the chat bar in a browser", () => {
  let browser: Browser | undefined;
  let bundle = "";

  // The page's bundle and the headless shell (installed before the suite) are setup, not behaviour deadlines.
  beforeAll(async () => {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "room-model-page.tsx")],
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

  async function open(query = ""): Promise<Page> {
    if (!browser) throw new Error("browser setup did not complete");
    const context = await browser.newContext();
    const page = await context.newPage();
    // No network: the page and its script are served here, anything else is refused.
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === ORIGIN && url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><div id="root"></div><script type="module" src="/room.js"></script>',
        });
      if (url.href === `${ORIGIN}/room.js`) return route.fulfill({ contentType: "text/javascript", body: bundle });
      return route.abort();
    });
    await page.goto(`${ORIGIN}/${query}`);
    await page.getByText("Three tickets triaged.").waitFor({ timeout: 5_000 });
    return page;
  }
  const label = (page: Page) => page.locator("[data-model-label]").innerText();
  const notes = (page: Page) => page.locator("[data-note] > span").allInnerTexts();
  const requests = (page: Page) =>
    page.evaluate(() => (window as unknown as { daemon: { requests: Record<string, unknown>[] } }).daemon.requests);
  const turn = (page: Page, state: string) =>
    page.evaluate((frame) => (window as unknown as { daemon: { emit(f: unknown): void } }).daemon.emit(frame), {
      type: "chat.turn",
      state,
      since: T0,
      queued: 0,
    });
  const focused = (page: Page) => page.evaluate(() => document.activeElement?.tagName ?? "");

  test("a click on the label opens Settings' picker; a choice switches the label and the room says so; ⌘⇧M and Escape", async () => {
    const page = await open();
    expect(await label(page)).toBe("Claude Keel");
    await page.getByRole("button", { name: "Coordinator model: Claude Keel" }).click();
    const picker = page.getByRole("dialog", { name: "Choose the coordinator's model" });
    await picker.waitFor({ timeout: 2_000 });
    // Settings' picker: its search holds the focus, its groups, the chosen model checked, what the choice applies to.
    expect(await picker.locator("[data-picker-head]").innerText()).toBe("For every project");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Search models");
    expect(
      await picker.locator("[data-picker-group]").evaluateAll((g) => g.map((e) => e.getAttribute("data-picker-group"))),
    ).toEqual(["anthropic", "openai-codex", "groq"]);
    expect(await picker.locator('[data-model="anthropic/claude-keel"]').getAttribute("aria-selected")).toBe("true");
    // A provider not connected is listed, dimmed, with where to connect it; choosing it does nothing.
    expect(await picker.locator('[data-picker-group="groq"] [data-reason]').innerText()).toBe("Connect in Settings");
    expect(await picker.locator('[data-model="groq/llama-dory"]').getAttribute("aria-disabled")).toBe("true");
    await picker.locator('[data-model="groq/llama-dory"]').dispatchEvent("click");
    expect(await picker.isVisible()).toBe(true);
    expect(await requests(page)).toEqual([]);

    await picker.locator('[data-model="openai-codex/codex-mini"]').click();
    await settled(() => label(page), "Codex Mini");
    expect(await picker.count()).toBe(0);
    expect(await focused(page)).toBe("TEXTAREA");
    expect(await requests(page)).toEqual([{ type: "models.select", provider: "openai-codex", model: "codex-mini" }]);
    await settled(() => notes(page), ["Coordinator now on openai-codex/codex-mini"]);
    // The line is the room's, after what was said: the conversation is unchanged.
    expect(
      await page.locator("[data-item]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-item"))),
    ).toEqual(["owner", "coordinator", "note"]);

    // ⌘⇧M opens it from the field, on the search; Escape closes it and gives the field back.
    await page.locator("textarea").focus();
    await page.keyboard.press("Meta+Shift+M");
    await picker.waitFor({ timeout: 2_000 });
    // The search finds a model by its words; Enter chooses it.
    await page.keyboard.type("skiff");
    expect(await picker.locator("[data-model]").evaluateAll((o) => o.map((e) => e.getAttribute("data-model")))).toEqual(
      ["anthropic/claude-skiff"],
    );
    await page.keyboard.press("Escape");
    await picker.waitFor({ state: "detached", timeout: 2_000 });
    expect(await focused(page)).toBe("TEXTAREA");
    expect((await requests(page)).length).toBe(1);
    await page.keyboard.press("Control+Shift+M");
    await picker.waitFor({ timeout: 2_000 });
    await page.keyboard.type("skiff");
    await page.keyboard.press("Enter");
    await settled(() => label(page), "Claude Skiff");
    expect(await notes(page)).toEqual([
      "Coordinator now on openai-codex/codex-mini",
      "Coordinator now on anthropic/claude-skiff",
    ]);
  });

  test("a choice during a turn waits for the next one: the label says so until the turn ends, then the room's line", async () => {
    const page = await open();
    await turn(page, "thinking");
    await page.locator("[data-working]").waitFor({ timeout: 2_000 });
    await page.locator("[data-model-label]").click();
    await page.locator('[data-model="anthropic/claude-skiff"]').click();
    await settled(() => label(page), "Claude Skiff · next turn");
    expect(await page.locator("[data-model-label]").getAttribute("aria-label")).toBe(
      "Coordinator model: Claude Skiff, next turn",
    );
    expect(await notes(page)).toEqual([]);
    await turn(page, "idle");
    await settled(() => label(page), "Claude Skiff");
    expect(await notes(page)).toEqual(["Coordinator now on anthropic/claude-skiff"]);
  });

  test("a project with its own model edits that one, and says so; an older daemon keeps the label a label", async () => {
    const page = await open("?override=1");
    expect(await label(page)).toBe("Claude Skiff");
    await page.locator("[data-model-label]").click();
    expect(await page.locator("[data-picker-head]").innerText()).toBe("For this project");
    await page.locator('[data-model="anthropic/claude-keel"]').click();
    await settled(() => label(page), "Claude Keel");
    expect(await requests(page)).toEqual([
      { type: "models.select", provider: "anthropic", model: "claude-keel", project: "harbor" },
    ]);
    await settled(() => notes(page), ["Coordinator now on anthropic/claude-keel"]);

    const older = await open("?override=1&minor=23");
    expect(await label(older)).toBe("Claude Skiff");
    expect(await older.locator("button[data-model-label]").count()).toBe(0);
    await older.locator("textarea").focus();
    await older.keyboard.press("Meta+Shift+M");
    expect(await older.getByRole("dialog").count()).toBe(0);
  });
});
