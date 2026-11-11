import { expect, test } from "@playwright/test";
import { IDS, MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

// Existing send/steer cases own refused drafts and one-shot model reset. This owns
// the independent race: typing another draft while an accepted action is in flight.
for (const intent of ["send", "steer"] as const) {
  test(`an accepted ${intent} keeps text written while its response is pending`, async ({ page }) => {
    await fetch(`${MOCK}/__test/sandbox-lifecycle`, {
      method: "POST",
      body: JSON.stringify({ id: IDS.running, fields: { status: "ready", conversation_ids: ["conv-a"] } }),
    });
    await fetch(`${MOCK}/__test/sandbox-events`, {
      method: "POST",
      body: JSON.stringify({
        sandbox: IDS.running,
        events:
          intent === "steer"
            ? [
                {
                  id: "pending-turn",
                  kind: "prompt",
                  at: 1_762_596_300_000,
                  text: "Inspect the parser",
                  status: "running",
                  conversationId: "conv-a",
                  promptId: "pending-turn",
                },
              ]
            : [],
      }),
    });
    await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    const action = page.getByRole("button", { name: intent === "send" ? "Send" : "Steer", exact: true });
    await expect(action).toBeVisible();
    let release!: () => void;
    let intercepted!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      intercepted = resolve;
    });
    await page.route(`**/sandboxes/${IDS.running}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      intercepted();
      await held;
      await route.continue();
    });
    try {
      await box.fill("Check the parser fixtures");
      await action.click();
      await started;
      await expect(action).toBeDisabled();
      await box.fill("Then review the release notes");
      release();
      await expect(page.getByRole("form", { name: "Message the agent" }).getByRole("status")).toHaveText(
        intent === "send" ? "Sent." : "Steered.",
      );
      await expect(box).toHaveValue("Then review the release notes");
      await expect(
        page.getByRole("log", { name: "Messages" }).getByText("Check the parser fixtures", { exact: true }),
      ).toBeVisible();
      // The new draft has not been silently sent as part of the first action.
      const state = await (await fetch(`${MOCK}/__test/state`)).json();
      expect(state.toolCalls.filter((call: { name: string }) => call.name === intent)).toHaveLength(1);
    } finally {
      release();
    }
  });
}
