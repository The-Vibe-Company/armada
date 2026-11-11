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
  await invite(page, "carol@corp", "admin");
  await expect(alert(page)).toContainText("Enter one full email address");
  await expect(page.getByLabel("Email")).toHaveValue("carol@corp");
  await expect(page.getByLabel("Role", { exact: true })).toHaveValue("admin");
  await expect(alert(page)).toBeFocused();

  // Fix only the address: retrying must keep the role the admin chose.
  await page.getByLabel("Email").fill("carol@example.com");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("Invitation emailed to carol@example.com.")).toBeVisible();
  await expect(page.locator('[data-invitation="carol@example.com"]')).toContainText("admin");
  await expect(page.getByLabel("Email")).toHaveValue("");
  await expect(page.getByLabel("Role", { exact: true })).toHaveValue("member");

  await mock("invitation-delivery", { delivery: "not_configured" });
  await invite(page, "dave@example.com");
  await expect(alert(page)).toContainText("this server cannot send email");
  await expect(page.locator('[data-invitation="dave@example.com"] [data-delivery="not_configured"]')).toHaveText(
    "Email off",
  );

  await invite(page, "carol@example.com", "admin");
  await expect(alert(page)).toContainText("already has a pending invitation");
  await expect(alert(page)).toBeFocused();
  await expect(page.getByLabel("Email")).toHaveValue("carol@example.com");
  await expect(page.getByLabel("Role", { exact: true })).toHaveValue("admin");
  await invite(page, "bob@example.com");
  await expect(alert(page)).toContainText("already a member");
});

test("the recipient signs in from the link, sees the org and joins only by accepting", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: TOKEN, role: "admin" });
  await page.goto(`/invitations/accept?token=${TOKEN}`);
  // The token leaves the address bar at once; the page itself never shows it.
  await expect(page).toHaveURL(/\/invitations\/accept$/);
  await expect(page.getByRole("heading", { name: "Sign in to review your invitation" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(TOKEN);

  await page.getByRole("link", { name: "Sign in to continue" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Finvitations%2Faccept$/);
  await expect(page.getByText("Use the address your invitation was sent to.")).toBeVisible();
  await page.getByLabel("Email").fill("carol@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByLabel("Code").fill("123456");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/invitations/accept");

  await expect(page.getByRole("heading", { name: "Join Acme" })).toBeVisible();
  await expect(page.getByText("You are invited as an admin.")).toBeVisible();
  await page.reload();
  // Opening and reloading the page only previews.
  expect((await mockState()).invitationCalls.map((call) => call.route)).toEqual(["preview", "preview"]);
  expect((await mockState()).members.some((member) => member.user_id === CAROL)).toBe(false);

  await page.getByRole("button", { name: "Accept and join Acme" }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]+\?joined=1$/);
  await expect(page.getByText("You joined Acme as an admin.")).toBeVisible();
  await expect(page.locator('[data-member="carol@example.com"]')).toBeVisible();
  // The org page an admin lands on lists invitations; the recipient flow itself made these calls only.
  const calls = (await mockState()).invitationCalls.filter((call) => call.route !== "list");
  expect(calls.map((call) => call.route)).toEqual(["preview", "preview", "accept"]);
  expect(calls.every((call) => JSON.stringify(call.body) === JSON.stringify({ token: TOKEN }))).toBe(true);

  // The link is spent: this browser forgot it.
  await page.goto("/invitations/accept");
  await expect(page.getByRole("heading", { name: "Open your invitation link" })).toBeVisible();
});

test("another account sees no org, is told to switch, and comes back to the invitation", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: TOKEN });
  await signIn(page, "bob@example.com");
  await page.goto(`/invitations/accept?token=${TOKEN}`);
  await expect(page.getByRole("heading", { name: "Signed in with another account" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Acme");
  await expect(page.getByRole("button", { name: /Accept/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Use another account" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Finvitations%2Faccept$/);
});

test("expired, revoked, used, unverified and already-member links each say what to do", async ({ page }) => {
  const visit = async (token: string) => page.goto(`/invitations/accept?token=${token}`);
  await signIn(page, "carol@example.com", "/orgs");

  await mock("seed-invitation", { email: "carol@example.com", token: `${TOKEN}1`, expiresInMs: -1000 });
  await visit(`${TOKEN}1`);
  await expect(page.getByRole("heading", { name: "Your invitation to Acme has expired" })).toBeVisible();

  await mock("seed-invitation", { email: "carol@example.com", token: `${TOKEN}2` });
  await mock("invitation-status", { token: `${TOKEN}2`, status: "revoked" });
  await visit(`${TOKEN}2`);
  await expect(page.getByRole("heading", { name: "Your invitation to Acme was revoked" })).toBeVisible();

  await mock("seed-invitation", { email: "carol@example.com", token: `${TOKEN}3` });
  await mock("invitation-status", { token: `${TOKEN}3`, status: "accepted" });
  await visit(`${TOKEN}3`);
  await expect(page.getByRole("heading", { name: "This invitation was already accepted" })).toBeVisible();

  await visit("unknown-token-0123456789");
  await expect(page.getByRole("heading", { name: "This invitation link is not valid" })).toBeVisible();

  await mock("seed-invitation", { email: "bob@example.com", token: `${TOKEN}4` });
  await page.context().clearCookies();
  await signIn(page, "bob@example.com");
  await visit(`${TOKEN}4`);
  await expect(page.getByRole("heading", { name: "You are already in Acme" })).toBeVisible();

  await mock("unverified-email", { email: "bob@example.com" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Verify your email first" })).toBeVisible();
  expect((await mockState()).invitationCalls.some((call) => call.route === "accept")).toBe(false);
});

test("a refusal at accept time is explained", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: TOKEN });
  await signIn(page, "carol@example.com", "/orgs");
  await page.goto(`/invitations/accept?token=${TOKEN}`);
  // Revoked between the preview and the click.
  await mock("invitation-status", { token: TOKEN, status: "revoked" });
  await page.getByRole("button", { name: "Accept and join Acme" }).click();
  await expect(alert(page)).toContainText("This invitation was revoked by an admin of the organization.");
});

test("a link without a token explains what to do", async ({ page }) => {
  await page.goto("/invitations/accept");
  await expect(page.getByRole("heading", { name: "Open your invitation link" })).toBeVisible();
});
