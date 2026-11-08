import { expect, test } from "@playwright/test";
import { IDS, MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

test("without a connection the settings offer Connect GitHub, which starts GitHub's authorization", async ({
  page,
}) => {
  await page.route("https://github.com/**", (route) => route.fulfill({ status: 200, body: "GitHub" }));
  await signIn(page, "alice@example.com", "/settings");
  const card = page.locator('[data-settings="github"]');
  await expect(card.getByText("Not connected.")).toBeVisible();

  const connect = card.getByRole("link", { name: "Connect GitHub" });
  await expect(connect).toHaveAttribute("href", "/github/connect");

  const [request] = await Promise.all([
    page.waitForRequest((candidate) => candidate.url().startsWith("https://github.com/login/oauth/authorize")),
    connect.click(),
  ]);
  const url = new URL(request.url());
  expect(url.searchParams.get("client_id")).toBe("Iv1.e2e");
  expect(url.searchParams.get("redirect_uri")).toMatch(/\/github\/callback$/);
  expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{48}$/);
  expect(url.toString()).not.toContain("e2e-client-secret");
});

test("a callback with a missing or foreign state connects nothing", async ({ page }) => {
  await signIn(page, "alice@example.com", "/settings");
  await page.goto("/github/callback?code=abc&state=forged");
  await page.waitForURL("**/settings?github=state");
  await expect(page.getByText("the sign-in expired or came from another browser")).toBeVisible();
  const rows = (await (await fetch(`${MOCK}/__test/github-connections`)).json()) as unknown[];
  expect(rows).toEqual([]);
});

test("a connected person sees who they are, and disconnecting removes only their own row", async ({ page }) => {
  await fetch(`${MOCK}/__test/github-connect`, {
    method: "POST",
    body: JSON.stringify({ user: IDS.alice, login: "octocat" }),
  });
  await fetch(`${MOCK}/__test/github-connect`, {
    method: "POST",
    body: JSON.stringify({ user: IDS.bob, login: "bobcat" }),
  });
  await signIn(page, "alice@example.com", "/settings");
  const card = page.locator('[data-settings="github"]');
  await expect(card.getByText("@octocat")).toBeVisible();
  await expect(card.getByText("583231+octocat@users.noreply.github.com")).toBeVisible();
  await expect(card.getByText("bobcat")).toHaveCount(0);
  expect(await page.content()).not.toContain("refresh_token_enc");

  await card.getByRole("button", { name: "Disconnect" }).click();
  await expect(card.getByText("Not connected.")).toBeVisible();
  const rows = (await (await fetch(`${MOCK}/__test/github-connections`)).json()) as { login: string }[];
  expect(rows.map((row) => row.login)).toEqual(["bobcat"]);
});

test("a revoked connection asks to reconnect", async ({ page }) => {
  await fetch(`${MOCK}/__test/github-connect`, {
    method: "POST",
    body: JSON.stringify({ user: IDS.alice, login: "octocat", revoked: true }),
  });
  await signIn(page, "alice@example.com", "/settings");
  const card = page.locator('[data-settings="github"]');
  await expect(card.getByText("GitHub access for @octocat was revoked or expired.")).toBeVisible();
  await expect(card.getByRole("link", { name: "Reconnect GitHub" })).toBeVisible();
});
