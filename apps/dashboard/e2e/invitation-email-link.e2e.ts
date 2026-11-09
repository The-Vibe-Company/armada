import { expect, type Page, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

/**
 * The invitation email's link as #649 sends it: a GoTrue email OTP this browser did not start, so GoTrue's confirmation
 * lands on `/invitations/accept?token=…` with a live session in the URL fragment (or, with a server-side template, a
 * `token_hash` in the query). The dashboard keeps only the invitation: those credentials are discarded unread, nobody
 * is signed in or out by the link, and the recipient signs in from this browser the ordinary way, back to the
 * invitation. No email is sent; the mock is GoTrue.
 */

test.beforeEach(reset);

const INVITATION = "mock-recipient-token-0123456789abcdef";
const CAROL = "00000000-0000-4000-8000-000000000003";

async function mock(path: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${MOCK}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return (await response.json()) as Record<string, string>;
}

const mockState = async () =>
  (await (await fetch(`${MOCK}/__test/state`, { method: "POST" })).json()) as {
    invitationCalls: { route: string }[];
    authCalls: string[];
    members: { user_id: string }[];
  };

/** The URL GoTrue's `/verify` redirects to for the default (implicit) email OTP: the session in the fragment. */
async function defaultSenderLink(email: string) {
  const session = await mock("email-link-session", { email });
  const fragment = new URLSearchParams({
    access_token: session.access_token ?? "",
    expires_at: String(session.expires_at),
    expires_in: "3600",
    refresh_token: session.refresh_token ?? "",
    token_type: "bearer",
    type: "magiclink",
  });
  return { url: `/invitations/accept?token=${INVITATION}#${fragment}`, session };
}

async function expectSanitized(page: Page) {
  await expect(page).toHaveURL(/\/invitations\/accept$/);
  const href = await page.evaluate(() => window.location.href);
  expect(href).not.toMatch(/access_token|refresh_token|token_hash|token=|#/);
}

const sessionCookies = async (page: Page) =>
  (await page.context().cookies()).filter((cookie) => /auth-token/.test(cookie.name)).map((cookie) => cookie.value);

/** The ordinary email-code sign-in on the login page, started from this browser. */
async function signInHere(page: Page, email: string) {
  await expect(page).toHaveURL(/\/login\?next=%2Finvitations%2Faccept$/);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByLabel("Code").fill("123456");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/invitations/accept");
}

const joined = async () => (await mockState()).members.some((member) => member.user_id === CAROL);

test("the default sender's link signs nobody in; the recipient signs in here and reviews, nothing joined", async ({
  page,
}) => {
  await mock("seed-invitation", { email: "carol@example.com", token: INVITATION });
  const link = await defaultSenderLink("carol@example.com");
  await page.goto(link.url);

  await expect(page.getByRole("heading", { name: "Sign in to review your invitation" })).toBeVisible();
  await expectSanitized(page);
  // The link's session was neither checked, refreshed nor stored, and nothing was previewed or accepted.
  expect((await mockState()).authCalls).toEqual([]);
  expect((await mockState()).invitationCalls).toEqual([]);
  expect(await sessionCookies(page)).toEqual([]);

  await page.getByRole("link", { name: "Sign in to continue" }).click();
  await signInHere(page, "carol@example.com");
  // The invitation survived the ordinary sign-in; the server's preview matched the verified address.
  await expect(page.getByRole("heading", { name: "Join Acme" })).toBeVisible();
  const cookies = (await sessionCookies(page)).join("");
  expect(cookies).not.toContain(link.session.access_token);
  expect(cookies).not.toContain(link.session.refresh_token);
  // Only the preview: the explicit join, and its result, are owned by e2e/invitations.e2e.ts.
  expect((await mockState()).invitationCalls.map((call) => call.route)).toEqual(["preview"]);
});

test("a token_hash link is never verified", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: INVITATION });
  await page.goto(`/invitations/accept?token=${INVITATION}&token_hash=pkce_0123456789abcdef&type=magiclink`);
  await expect(page.getByRole("heading", { name: "Sign in to review your invitation" })).toBeVisible();
  await expectSanitized(page);
  expect((await mockState()).authCalls).toEqual([]);
  expect(await sessionCookies(page)).toEqual([]);
});

test("a forwarded link carrying someone else's session signs nobody in", async ({ page }) => {
  // An attacker forwards the link of their own invitation, with their own live session in it.
  await mock("seed-invitation", { email: "bob@example.com", token: INVITATION });
  await page.goto((await defaultSenderLink("bob@example.com")).url);
  await expectSanitized(page);
  expect(await sessionCookies(page)).toEqual([]);

  await page.getByRole("link", { name: "Sign in to continue" }).click();
  await signInHere(page, "carol@example.com");
  await expect(page.getByRole("heading", { name: "Signed in with another account" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Acme");
  expect((await mockState()).invitationCalls.some((call) => call.route === "accept")).toBe(false);
});

test("a signed-in different account is untouched, and switches only the ordinary way", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: INVITATION });
  await signIn(page, "bob@example.com");
  const before = await sessionCookies(page);
  const calls = (await mockState()).authCalls.length;

  await page.goto((await defaultSenderLink("carol@example.com")).url);
  await expect(page.getByRole("heading", { name: "Signed in with another account" })).toBeVisible();
  await expectSanitized(page);
  expect(await sessionCookies(page)).toEqual(before);
  expect((await mockState()).authCalls.slice(calls)).not.toContain("/token");
  expect((await mockState()).authCalls.slice(calls)).not.toContain("/verify");

  await page.getByRole("button", { name: "Use another account" }).click();
  await signInHere(page, "carol@example.com");
  await expect(page.getByRole("heading", { name: "Join Acme" })).toBeVisible();
  expect(await joined()).toBe(false);
});

test("the invited account, already signed in, keeps its own session and reviews before joining", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: INVITATION });
  await signIn(page, "carol@example.com");
  const before = await sessionCookies(page);
  await page.goto((await defaultSenderLink("carol@example.com")).url);
  await expect(page.getByRole("heading", { name: "Join Acme" })).toBeVisible();
  await expectSanitized(page);
  expect(await sessionCookies(page)).toEqual(before);
  expect((await mockState()).invitationCalls.some((call) => call.route === "accept")).toBe(false);
});

test("a pending invitation does not take over another sign-in's return target", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: INVITATION });
  await page.goto(`/invitations/accept?token=${INVITATION}`);
  await signIn(page, "carol@example.com", "/credentials");
  await expect(page).toHaveURL(/\/credentials$/);
});
