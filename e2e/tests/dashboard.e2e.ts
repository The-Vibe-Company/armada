import { test } from "@e2e-dev/web";
import { credentials, expect } from "e2e";
import { openDatabase, transaction } from "../../packages/dashboard/lib/db";
import { act } from "../act";
import { demoEnv } from "../demo-env";

test("the landing opens without a session", async ({ app, screen, browser }) => {
  await app.open("/");
  await expect(screen.getByRole("heading", { name: "Run a fleet of coding agents. See every move." })).toBeVisible();
  await app.open("/validations");
  await expect(browser).toHaveURL(/\/login\?next=/);
});

test("the owner signs in and sees the overview headline", async ({ app, agent, screen, browser }) => {
  const owner = credentials.user("owner");
  await app.open("/login");
  await act(agent, "Sign in with email {email} and password {password} using the sign-in form.", {
    email: owner.username,
    password: owner.password,
  });
  await expect(browser).toHaveURL("/");
  await expect(screen.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(browser.locator(".ov-headline")).toContainText("waiting for your decision");
});

test("the owner approves a waiting validation and the list moves on", async ({ app, agent, screen, browser }) => {
  // Restore only this demo decision before every attempt, including retries.
  // Sign-in and the decision itself still go through the browser's real forms.
  const db = await openDatabase(demoEnv.ARMADA_DATABASE_URL);
  try {
    await transaction(db, async (tx) => {
      await tx.query(
        "DELETE FROM inbox_items WHERE kind = 'decision' AND project = $1 AND request_validation IN (SELECT id FROM validations WHERE project = $1 AND ticket = $2 AND kind = 'validation')",
        ["gadgets", "GAD-9"],
      );
      await tx.query(
        "UPDATE validations SET decided_at = NULL, outcome = NULL, answer = NULL, note = NULL, decided_by = NULL WHERE project = $1 AND ticket = $2 AND kind = 'validation'",
        ["gadgets", "GAD-9"],
      );
    });
  } finally {
    await db.end();
  }
  const owner = credentials.user("owner");
  await app.open("/login");
  await screen.getByRole("textbox", { name: "Email", exact: true }).fill(owner.username);
  await screen.getByLabel("Password", { exact: true }).fill(owner.password);
  await screen.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(browser).toHaveURL("/");
  await app.open("/validations");
  // The row's accessible name includes its changing age. Match its stable ticket
  // and kind so a recording never depends on elapsed minutes.
  await screen.getByRole("link", { name: /^To validate .*GAD-9 Gadgets$/ }).click();
  await expect(screen.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(browser.locator('.vd-row[aria-current="true"]')).toContainText("GAD-9");
  const selected = await browser.url();
  await act(
    agent,
    "Approve this product card design validation once using the Approve button, then observe the next waiting validation.",
  );
  await expect(browser).not.toHaveURL(selected);
  await expect(screen.getByRole("navigation", { name: "Validations", exact: true })).toContainText(
    "Approved by Olive Owner",
  );
  // A reload proves the decision was saved, rather than only removed optimistically.
  await browser.reload();
  await expect(screen.getByRole("navigation", { name: "Validations", exact: true })).toContainText(
    "Approved by Olive Owner",
  );
  await expect(browser.locator('.vd-row[aria-current="true"]')).not.toContainText("GAD-9");
});
