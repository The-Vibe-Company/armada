/** Current mock only; before/after use the same seeded conversation and accounts. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { IDS, MOCK, reset, signIn } from "../e2e/helpers";

const phase = process.env.EVIDENCE_PHASE;
if (phase !== "before" && phase !== "after") throw new Error("EVIDENCE_PHASE must be before or after");
const output = process.env.EVIDENCE_DIR ?? "test-results/conversation-evidence";
await mkdir(output, { recursive: true });
const post = async (path: string, body: unknown) => {
  const response = await fetch(`${MOCK}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });
  expect(response.ok).toBe(true);
};
const browser = await chromium.launch();
try {
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"] as const) {
      await reset();
      await post("sandbox-lifecycle", { id: IDS.running, fields: { status: "ready", conversation_ids: ["conv-a"] } });
      const common = { conversationId: "conv-a", promptId: "p1" };
      await post("sandbox-events", {
        sandbox: IDS.running,
        events: [
          {
            ...common,
            id: "p1",
            at: 1_762_596_300_000,
            kind: "prompt",
            text: "Check the parser fixtures",
            status: "finished",
          },
          {
            ...common,
            id: "m1",
            at: 1_762_596_301_000,
            kind: "message",
            text: "I found a failing parser fixture.",
            partial: false,
            tools: [{ id: "t1", name: "Bash", input: { command: "bun test parser" } }],
          },
          {
            ...common,
            id: "m2",
            at: 1_762_596_302_000,
            kind: "message",
            text: "",
            partial: false,
            tools: [{ id: "t1", name: "tool_result", result: { output: "1 fail: expected 3, got 2", isError: true } }],
          },
          {
            id: "e1",
            at: 1_762_596_303_000,
            kind: "other",
            type: "rate_limits",
            data: { remaining: 12 },
            conversationId: "conv-a",
          },
        ],
      });
      const context = await browser.newContext({
        baseURL: "http://127.0.0.1:3100",
        viewport: { width, height: 844 },
        reducedMotion: "reduce",
        colorScheme: theme,
      });
      try {
        await context.addInitScript((value) => localStorage.setItem("theme", value), theme);
        const page = await context.newPage();
        await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
        const messages = page.getByRole("log", { name: "Messages" });
        await expect(messages.getByText("I found a failing parser fixture.", { exact: true })).toBeVisible();
        await messages.getByRole("button", { name: /Bash.*bun test parser/ }).click();
        await expect(messages.getByText("1 fail: expected 3, got 2", { exact: true })).toBeVisible();
        await page.getByText("Technical events (1)", { exact: true }).click();
        await expect(page.getByRole("list", { name: "Technical events" })).toBeVisible();
        const capture = async (view: string) => {
          await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /light/);
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({
            path: join(output, `${phase}-${view}-${width}-${theme}.png`),
            fullPage: true,
            animations: "disabled",
          });
        };
        await capture("conversation");
        await page.getByText("Technical events (1)", { exact: true }).click();
        await page.getByRole("button", { name: "Model", exact: true }).click();
        await page
          .getByRole("textbox", { name: "Message", exact: true })
          .fill("Keep the last token and add a regression test");
        await expect(page.getByLabel("Reasoning effort")).toBeVisible();
        await capture("composer");
        await page.getByRole("button", { name: "Model", exact: true }).click();
        if (width < 1024) await page.getByRole("button", { name: "Details", exact: true }).click();
        await expect(
          page.getByRole("region", { name: "Details", exact: true }).getByText("Golden", { exact: true }),
        ).toBeVisible();
        await capture("details");
        await post("sandbox-lifecycle", {
          id: IDS.running,
          fields: { provider: "modal", status: "stopped", credential_id: null, credential_version: null },
        });
        const account = (suffix: string, name: string) => ({
          id: `00000000-0000-4000-8000-0000000009${suffix}`,
          kind: "claude_oauth",
          name,
          isDefault: false,
          status: "active",
          expiresAt: null,
          updatedAt: "2026-11-10T10:00:00.000Z",
          version: 3,
          createdAt: "2026-11-01T10:00:00.000Z",
        });
        await post("accounts", {
          user: [account("01", "Work subscription"), account("02", "Review subscription")],
          org: [],
        });
        await page.reload();
        const choice = page.getByRole("region", { name: "Choose this sandbox's account" });
        await choice.getByRole("radio", { name: /Work subscription/ }).check();
        await expect(choice.getByRole("button", { name: "Use this account" })).toBeEnabled();
        await capture("account");
      } finally {
        await context.close();
      }
    }
} finally {
  await browser.close();
}
if (phase === "after") {
  const parts: string[] = [];
  for (const view of ["conversation", "composer", "details", "account"])
    for (const width of [1280, 390])
      for (const theme of ["light", "dark"]) {
        parts.push(`<h2>${view}: ${width}px, ${theme}</h2><div class="pair">`);
        for (const side of ["before", "after"]) {
          const file = `${side}-${view}-${width}-${theme}.png`;
          parts.push(`<a href="${file}">${side}<img src="${file}" alt="${side} ${view} ${width} ${theme}"></a>`);
        }
        parts.push("</div>");
      }
  await writeFile(
    join(output, "index.html"),
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Conversation quality evidence</title><style>body{font:16px system-ui;margin:24px}.pair{display:flex;gap:16px;align-items:start}.pair a{width:50%}img{width:100%}</style><h1>Sandbox conversation/detail before/after</h1><p>32 mock-only captures. Source provenance in README.txt; click for full size.</p>${parts.join("")}`,
  );
}
