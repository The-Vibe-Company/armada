import { expect, type Page, test } from "@playwright/test";
import { alert, MOCK, reset, signIn } from "./helpers";

/**
 * The invitation email's own sign-in (#640 sends a GoTrue email OTP without a PKCE challenge from this browser). Each
 * test starts from the URL GoTrue's confirmation redirects to: the invitation link, with the session in its fragment
 * (the default) or a `token_hash` (a server-side template). No email is sent; the mock is GoTrue.
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

/** The fragment GoTrue's `/verify` redirect carries for an implicit (non-PKCE) email OTP. */
function fragment(session: Record<string, string>) {
  const params = new URLSearchParams({
    access_token: session.access_token ?? "",
    expires_at: String(session.expires_at),
    expires_in: "3600",
    refresh_token: session.refresh_token ?? "",
    token_type: "bearer",
    type: "magiclink",
  });
  return `#${params}`;
}

const emailLink = async (email: string) => fragment(await mock("email-link-session", { email }));
const incoming = (hash: string) => `/invitations/accept?token=${INVITATION}${hash}`;

async function expectSanitized(page: Page) {
  await expect(page).toHaveURL(/\/invitations\/accept$/);
  const href = await page.evaluate(() => window.location.href);
  expect(href).not.toMatch(/access_token|refresh_token|token=|#/);
}

const joined = async () => (await mockState()).members.some((member) => member.user_id === CAROL);

test("a signed-out recipient confirms the link's account, reviews the org, then joins by choice", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: INVITATION });
  const link = await emailLink("carol@example.com");
  await page.goto(incoming(link));

  await expect(page.getByRole("heading", { name: "Continue as carol@example.com?" })).toBeVisible();
  await expect(page.getByText("invited to Acme")).toBeVisible();
  await expectSanitized(page);
  // GoTrue vouched for the account and the server bound it to the invitation; nothing is stored or joined yet.
  let state = await mockState();
  expect(state.authCalls).toEqual(["/user"]);
  expect(state.invitationCalls.map((call) => call.route)).toEqual(["preview"]);
  expect(await page.context().cookies()).not.toContainEqual(
    expect.objectContaining({ name: expect.stringMatching(/auth-token/) }),
  );

  await page.getByRole("button", { name: "Continue as carol@example.com" }).click();
  await expect(page.getByRole("heading", { name: "Join Acme" })).toBeVisible();
  await expectSanitized(page);
  state = await mockState();
  // The stored session is the one GoTrue minted for the refresh token, checked against the access token's account.
  expect(state.authCalls.slice(0, 3)).toEqual(["/user", "/user", "/token"]);
  expect(state.invitationCalls.some((call) => call.route === "accept")).toBe(false);
  expect(await joined()).toBe(false);

  await page.getByRole("button", { name: "Accept and join Acme" }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]+\?joined=1$/);
  expect(await joined()).toBe(true);
});

test("another signed-in account is never replaced without choosing to", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: INVITATION });
  await signIn(page, "bob@example.com");
  await page.goto(incoming(await emailLink("carol@example.com")));
  await expect(page.getByText("This browser is signed in as bob@example.com.")).toBeVisible();
  await expectSanitized(page);

  await page.getByRole("button", { name: "Stay as bob@example.com" }).click();
  await expect(page.getByRole("heading", { name: "Signed in with another account" })).toBeVisible();
  await page.goto("/sandboxes");
  await expect(page.getByText("Signed in as bob@example.com")).toBeVisible();

  await page.goto(incoming(await emailLink("carol@example.com")));
  await page.getByRole("button", { name: "Continue as carol@example.com" }).click();
  await expect(page.getByRole("heading", { name: "Join Acme" })).toBeVisible();
  await expect(page.getByText("Signed in as carol@example.com")).toBeVisible();
  expect(await joined()).toBe(false);
});

test("a link for another address, or a mismatched session pair, signs nobody in", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: INVITATION });
  // A valid session for someone the invitation was not sent to.
  await page.goto(incoming(await emailLink("bob@example.com")));
  await expect(alert(page)).toContainText("This invitation is for another email address.");
  await expectSanitized(page);

  // Carol's access token with Bob's refresh token: it must not sign in as Carol and refresh into Bob.
  const carol = await mock("email-link-session", { email: "carol@example.com" });
  const bob = await mock("email-link-session", { email: "bob@example.com" });
  await page.goto(incoming(fragment({ ...carol, refresh_token: bob.refresh_token ?? "" })));
  await page.getByRole("button", { name: "Continue as carol@example.com" }).click();
  await expect(alert(page)).toContainText("could not be verified");
  await page.goto("/invitations/accept");
  await expect(page.getByRole("heading", { name: "You are invited to an organization on Armada" })).toBeVisible();
  expect((await mockState()).invitationCalls.some((call) => call.route === "accept")).toBe(false);
});

test("an expired email link says to sign in with the email address", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: INVITATION });
  await page.goto(
    incoming("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired"),
  );
  await expect(alert(page)).toContainText("expired or was already used");
  await expectSanitized(page);
  await page.getByRole("link", { name: "Sign in with your email address" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Finvitations%2Faccept$/);
});

test("a token_hash link is verified only when the recipient continues, once", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: INVITATION });
  const { token_hash } = await mock("email-link-hash", { email: "carol@example.com" });
  await page.goto(`/invitations/accept?token=${INVITATION}&token_hash=${token_hash}&type=magiclink`);
  await expectSanitized(page);
  await expect(page.getByRole("heading", { name: "Sign in to review your invitation" })).toBeVisible();
  expect((await mockState()).authCalls).toEqual([]);

  await page.getByRole("button", { name: "Continue with this link" }).click();
  await expect(page.getByRole("heading", { name: "Join Acme" })).toBeVisible();
  expect((await mockState()).authCalls[0]).toBe("/verify");
  expect(await joined()).toBe(false);
});

test("a pending invitation does not take over another sign-in's return target", async ({ page }) => {
  await mock("seed-invitation", { email: "carol@example.com", token: INVITATION });
  await page.goto(`/invitations/accept?token=${INVITATION}`);
  await signIn(page, "carol@example.com", "/credentials");
  await expect(page).toHaveURL(/\/credentials$/);
});
