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

test("connecting stores only ciphertext, Disconnect forgets it, and connecting again works", async ({ page }) => {
  await page.route("https://github.com/**", (route) => route.fulfill({ status: 200, body: "GitHub" }));
  await signIn(page, "alice@example.com", "/settings");
  const card = page.locator('[data-settings="github"]');
  const connections = async () =>
    (await (await fetch(`${MOCK}/__test/github-connections`)).json()) as {
      user_id: string;
      login: string;
      refresh_token_enc: string;
    }[];

  const authorize = async (link: string) => {
    const [request] = await Promise.all([
      page.waitForRequest((candidate) => candidate.url().startsWith("https://github.com/login/oauth/authorize")),
      card.getByRole("link", { name: link }).click(),
    ]);
    const state = new URL(request.url()).searchParams.get("state");
    await page.goto(`/github/callback?code=good-code&state=${state}`);
    await page.waitForURL("**/settings?github=connected");
  };

  await authorize("Connect GitHub");
  await expect(card.getByText("@octocat")).toBeVisible();
  const [first] = await connections();
  expect(first).toMatchObject({ user_id: IDS.alice, login: "octocat" });
  expect(first?.refresh_token_enc).toMatch(/^\\x[0-9a-f]+$/);
  expect(JSON.stringify(first)).not.toContain("ghr_e2e_refresh");
  expect(await page.content()).not.toContain("refresh_token_enc");

  await page.goto("/settings");
  await card.getByRole("button", { name: "Disconnect" }).click();
  await expect(card.getByText("Not connected.")).toBeVisible();
  expect(await connections()).toEqual([]);

  await authorize("Connect GitHub");
  const reconnected = await connections();
  expect(reconnected).toHaveLength(1);
  expect(reconnected[0]?.refresh_token_enc).not.toBe(first?.refresh_token_enc);
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

test("a connection with an installation on file shows Manage installation", async ({ page }) => {
  await fetch(`${MOCK}/__test/github-connect`, {
    method: "POST",
    body: JSON.stringify({ user: IDS.alice, login: "octocat", installationId: 9001 }),
  });
  await signIn(page, "alice@example.com", "/settings");
  const card = page.locator('[data-settings="github"]');
  await expect(card.getByText("App installed")).toBeVisible();
  const manage = card.getByRole("link", { name: "Manage installation" });
  await expect(manage).toHaveAttribute("href", "https://github.com/settings/installations/9001");
});

test("a connection without an installation on file offers to install it", async ({ page }) => {
  await fetch(`${MOCK}/__test/github-connect`, {
    method: "POST",
    body: JSON.stringify({ user: IDS.alice, login: "octocat" }),
  });
  await signIn(page, "alice@example.com", "/settings");
  const card = page.locator('[data-settings="github"]');
  await expect(card.getByText("Not installed anywhere you can reach yet")).toBeVisible();
  const install = card.getByRole("link", { name: "Install the app" });
  await expect(install).toHaveAttribute("href", "https://github.com/apps/armada-e2e/installations/new");
});

test("Connect GitHub with no installation anywhere routes on to install it, and the return finishes the connection", async ({
  page,
}) => {
  await fetch(`${MOCK}/__test/github-installations`, { method: "POST", body: JSON.stringify({ installations: [] }) });
  await page.route("https://github.com/**", (route) => route.fulfill({ status: 200, body: "GitHub" }));
  await signIn(page, "alice@example.com", "/settings");
  const card = page.locator('[data-settings="github"]');

  const [authorize] = await Promise.all([
    page.waitForRequest((candidate) => candidate.url().startsWith("https://github.com/login/oauth/authorize")),
    card.getByRole("link", { name: "Connect GitHub" }).click(),
  ]);
  const oauthState = new URL(authorize.url()).searchParams.get("state");

  const [install] = await Promise.all([
    page.waitForRequest((candidate) =>
      candidate.url().startsWith("https://github.com/apps/armada-e2e/installations/new"),
    ),
    page.goto(`/github/callback?code=good-code&state=${oauthState}`),
  ]);
  const installUrl = new URL(install.url());
  expect(installUrl.pathname).toBe("/apps/armada-e2e/installations/new");
  const installState = installUrl.searchParams.get("state");
  expect(installState).toMatch(/^[0-9a-f]{48}$/);
  // Connect GitHub already saved the connection before routing to install.
  expect(await (await fetch(`${MOCK}/__test/github-connections`)).json()).toMatchObject([
    { login: "octocat", installation_id: null },
  ]);

  await fetch(`${MOCK}/__test/github-installations`, {
    method: "POST",
    body: JSON.stringify({ installations: [{ id: 9001, app_slug: "armada-e2e", account: { login: "octocat" } }] }),
  });
  await page.goto(`/github/callback?setup_action=install&installation_id=9001&code=good-code&state=${installState}`);
  await page.waitForURL("**/settings?github=connected");
  await expect(card.getByText("App installed")).toBeVisible();
  expect(await (await fetch(`${MOCK}/__test/github-connections`)).json()).toMatchObject([
    { login: "octocat", installation_id: 9001 },
  ]);
});

test("an installation return with no state cookie still finishes the connection, once GitHub confirms it", async ({
  page,
}) => {
  await fetch(`${MOCK}/__test/github-installations`, {
    method: "POST",
    body: JSON.stringify({ installations: [{ id: 9001, app_slug: "armada-e2e", account: { login: "octocat" } }] }),
  });
  await signIn(page, "alice@example.com", "/settings");
  // No visit to /github/connect or the install link happened: there is no state cookie at all,
  // the way a GitHub-initiated installation return can arrive. See docs/github-app.md.
  await page.goto("/github/callback?setup_action=install&installation_id=9001&code=good-code");
  await page.waitForURL("**/settings?github=connected");
  const card = page.locator('[data-settings="github"]');
  await expect(card.getByText("@octocat")).toBeVisible();
  await expect(card.getByText("App installed")).toBeVisible();
});

test("an installation return claiming an installation GitHub does not list for the app is refused", async ({
  page,
}) => {
  await fetch(`${MOCK}/__test/github-installations`, {
    method: "POST",
    body: JSON.stringify({ installations: [{ id: 9001, app_slug: "armada-e2e", account: { login: "octocat" } }] }),
  });
  await signIn(page, "alice@example.com", "/settings");
  await page.goto("/github/callback?setup_action=install&installation_id=4242&code=good-code");
  await page.waitForURL("**/settings?github=install_mismatch");
  expect(await (await fetch(`${MOCK}/__test/github-connections`)).json()).toEqual([]);
});

test("an installation return with no state cookie never switches an already-connected person to a different GitHub account", async ({
  page,
}) => {
  await fetch(`${MOCK}/__test/github-connect`, {
    method: "POST",
    body: JSON.stringify({ user: IDS.alice, login: "someone-else", githubId: 1 }),
  });
  await fetch(`${MOCK}/__test/github-installations`, {
    method: "POST",
    body: JSON.stringify({ installations: [{ id: 9001, app_slug: "armada-e2e", account: { login: "octocat" } }] }),
  });
  await signIn(page, "alice@example.com", "/settings");
  await page.goto("/github/callback?setup_action=install&installation_id=9001&code=good-code");
  await page.waitForURL("**/settings?github=mismatch");
  expect(await (await fetch(`${MOCK}/__test/github-connections`)).json()).toMatchObject([
    { login: "someone-else", github_id: 1 },
  ]);
});
