import { expect, type Page, test } from "@playwright/test";
import { alert, MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

const TOKEN = "mock-recipient-token-0123456789abcdef";
const CAROL = "00000000-0000-4000-8000-000000000003";

async function mock(path: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${MOCK}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return (await response.json()) as Record<string, unknown>;
}

const mockState = async () =>
  (await (await fetch(`${MOCK}/__test/state`, { method: "POST" })).json()) as {
    invitationCalls: { route: string; body: Record<string, unknown>; authorized: boolean }[];
    invitations: { email: string; status: string; delivery: string }[];
    members: { org_id: string; user_id: string; role: string }[];
  };

async function openAcme(page: Page) {
  await signIn(page, "alice@example.com", "/orgs");
  await page.getByRole("link", { name: /Acme/ }).click();
  await expect(page.getByRole("heading", { name: "Invite a teammate" })).toBeVisible();
}

async function invite(page: Page, email: string, role: "member" | "admin" = "member") {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Role", { exact: true }).selectOption(role);
  await page.getByRole("button", { name: "Send invitation" }).click();
}

test("an admin invites, resends and revokes, and the list shows honest delivery", async ({ page }) => {
  await openAcme(page);
  await invite(page, "  Dave@Example.com ", "admin");
  await expect(page.getByText("Invitation emailed to dave@example.com.")).toBeVisible();
  const dave = page.locator('[data-invitation="dave@example.com"]');
  await expect(dave).toContainText("admin");
  await expect(dave.locator('[data-delivery="sent"]')).toHaveText("Sent");

  // The mail transport refuses the resend: the row says so and nothing claims it was sent.
  await mock("invitation-delivery", { delivery: "failed" });
  await dave.getByRole("button", { name: "Resend the invitation to dave@example.com" }).click();
  await expect(dave.getByRole("alert")).toContainText("its email was refused. Resend it.");
  await expect(dave.locator('[data-delivery="failed"]')).toHaveText("Not sent");

  await dave.getByRole("button", { name: "Revoke the invitation to dave@example.com" }).click();
  await expect(page.locator('[data-invitation="dave@example.com"]')).toHaveCount(0);
  await expect(page.getByText("No pending invitations.")).toBeVisible();

  const state = await mockState();
  const writes = state.invitationCalls.filter((call) => call.route !== "list");
  expect(writes.map((call) => call.route)).toEqual(["create", "resend", "revoke"]);
  expect(state.invitationCalls.every((call) => call.authorized)).toBe(true);
  expect(writes[0]?.body).toMatchObject({ email: "dave@example.com", role: "admin" });
});

test("a server without email is reported as such, and invalid or duplicate invitations are refused", async ({
  page,
}) => {
  await openAcme(page);
  await invite(page, "carol@corp");
  await expect(alert(page)).toContainText("Enter one full email address");

  await mock("invitation-delivery", { delivery: "not_configured" });
  await invite(page, "carol@example.com");
  await expect(alert(page)).toContainText("this server cannot send email");
  await expect(page.locator('[data-invitation="carol@example.com"] [data-delivery="not_configured"]')).toHaveText(
    "Email off",
  );

  await invite(page, "carol@example.com");
  await expect(alert(page)).toContainText("already has a pending invitation");
  await invite(page, "bob@example.com");
  await expect(alert(page)).toContainText("already a member");
});

test("the recipient signs in from the link and joins only by accepting", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: TOKEN });
  await page.goto(`/invitations/accept?token=${TOKEN}`);
  // The token leaves the address bar at once; the page itself never shows it.
  await expect(page).toHaveURL(/\/invitations\/accept$/);
  await expect(page.getByRole("heading", { name: "You are invited to an organization on Armada" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(TOKEN);

  await page.getByRole("link", { name: "Sign in to accept" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Finvitations%2Faccept$/);
  await page.getByLabel("Email").fill("carol@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByLabel("Code").fill("123456");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/invitations/accept");

  await expect(page.getByRole("heading", { name: "Accept your invitation" })).toBeVisible();
  await page.reload();
  // Opening and reloading the page never accepts.
  expect((await mockState()).invitationCalls).toEqual([]);

  await page.getByRole("button", { name: "Accept and join" }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]+\?joined=1$/);
  await expect(page.getByText("You joined Acme as a member.")).toBeVisible();
  await expect(page.locator('[data-member="carol@example.com"]')).toBeVisible();
  const calls = (await mockState()).invitationCalls;
  expect(calls.map((call) => call.route)).toEqual(["accept"]);
  expect(calls[0]?.body).toEqual({ token: TOKEN });

  // The link is spent: this browser forgot it.
  await page.goto("/invitations/accept");
  await expect(page.getByRole("heading", { name: "Open your invitation link" })).toBeVisible();
});

test("another account is told to switch, and comes back to the invitation", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: TOKEN });
  await signIn(page, "bob@example.com");
  await page.goto(`/invitations/accept?token=${TOKEN}`);
  await expect(page.getByText("You are signed in as bob@example.com")).toBeVisible();
  await page.getByRole("button", { name: "Accept and join" }).click();
  await expect(alert(page)).toContainText("This invitation is for another email address");

  await page.getByRole("button", { name: "Use another account" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Finvitations%2Faccept$/);
});

test("an expired, revoked or replaced link says to ask for a new one", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: TOKEN, expiresInMs: -1000 });
  await signIn(page, "carol@example.com", "/orgs");
  await page.goto(`/invitations/accept?token=${TOKEN}`);
  await page.getByRole("button", { name: "Accept and join" }).click();
  await expect(alert(page)).toContainText("no longer valid");
  await expect(alert(page)).toContainText("Ask an admin to resend it.");
  expect((await mockState()).members.some((member) => member.user_id === CAROL)).toBe(false);
});

test("a link without a token explains what to do", async ({ page }) => {
  await page.goto("/invitations/accept");
  await expect(page.getByRole("heading", { name: "Open your invitation link" })).toBeVisible();
});
