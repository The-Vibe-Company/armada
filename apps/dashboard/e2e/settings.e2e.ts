import { expect, test } from "@playwright/test";
import { IDS, MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

async function connections(): Promise<
  { user_id?: string; login?: string; installations?: unknown; refresh_token_enc?: string }[]
> {
  return (await (await fetch(`${MOCK}/__test/github-connections`)).json()) as {
    user_id?: string;
    login?: string;
    installations?: unknown;
    refresh_token_enc?: string;
  }[];
}

test("without a connection the settings offer Connect GitHub, which starts GitHub's authorization", async ({
  page,
}) => {
  await page.route("https://github.com/**", (route) => route.fulfill({ status: 200, body: "GitHub" }));
  await signIn(page, "alice@example.com", "/settings");
  const card = page.locator('[data-settings="github"]');
  await expect(card.locator("[data-github-state]")).toHaveAttribute("data-github-state", "not-connected");

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
  await expect(card.getByText("All repositories")).toBeVisible();
  await expect(card.getByRole("link", { name: "Manage installation" })).toHaveAttribute(
    "href",
    "https://github.com/settings/installations/4242",
  );
  await expect(card.getByText("other", { exact: true })).toHaveCount(0);
  const [first] = await connections();
  expect(first).toMatchObject({ user_id: IDS.alice, login: "octocat" });
  expect(first?.installations).toEqual([
    { id: 4242, account: "octocat", account_type: "User", repository_selection: "all" },
  ]);
  expect(first?.refresh_token_enc).toMatch(/^\\x[0-9a-f]+$/);
  expect(JSON.stringify(first)).not.toContain("ghr_e2e_refresh");
  expect(await page.content()).not.toContain("refresh_token_enc");

  await page.goto("/settings");
  await card.getByRole("button", { name: "Disconnect" }).click();
  await expect(card.locator("[data-github-state]")).toHaveAttribute("data-github-state", "not-connected");
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
  // A lookalike of the CLI prefix stays on the web flow, so its state cookie is still required.
  await page.goto(`/github/callback?code=abc&state=Armada_cli_${"a".repeat(40)}`);
  await page.waitForURL("**/settings?github=state");
  const rows = (await (await fetch(`${MOCK}/__test/github-connections`)).json()) as unknown[];
  expect(rows).toEqual([]);
  expect((await cliState()).githubCliCalls).toEqual([]);
});

async function cliState() {
  return (await (await fetch(`${MOCK}/__test/state`)).json()) as {
    githubCliCalls: { body: Record<string, unknown>; authorization: string | null; cookie: string | null }[];
  };
}

/**
 * A flow state of the shape the API (#529) creates: `armada_cli_` and 72 lowercase hex or hyphen characters. The
 * mock refuses to register any other shape, so these tests only exercise states the API could have issued.
 */
async function cliFlow(code: string, canceled = false): Promise<string> {
  const state = `armada_cli_${crypto.randomUUID()}${crypto.randomUUID()}`;
  const response = await fetch(`${MOCK}/__test/github-cli-flow`, {
    method: "POST",
    body: JSON.stringify({ state, code, canceled }),
  });
  expect(response.ok).toBe(true);
  return state;
}

test("the CLI's GitHub sign-in completes through the registered callback, relaying only state and code", async ({
  page,
  context,
}) => {
  // A signed-in browser with a web flow in progress: neither its session nor its state cookie reaches the API.
  await signIn(page, "alice@example.com", "/settings");
  await context.addCookies([
    { name: "armada_github_state", value: "web-flow-state", url: "http://127.0.0.1:3100/github/callback" },
  ]);
  const state = await cliFlow("cli-code-1");
  await page.goto(`/github/callback?code=cli-code-1&state=${state}`);
  await expect(page).toHaveURL(/\/github\/cli\?result=connected$/);
  await expect(page.getByRole("status")).toContainText("GitHub is connected");
  await page.screenshot({ path: "test-results/github-cli-connected-desktop.png" });
  expect((await cliState()).githubCliCalls).toEqual([
    { body: { state, code: "cli-code-1" }, authorization: null, cookie: null },
  ]);
  // The web flow's cookie is left alone for that flow, and no web connection was made.
  expect((await context.cookies()).some((cookie) => cookie.name === "armada_github_state")).toBe(true);
  expect(await connections()).toEqual([]);

  // Replaying the same callback is refused by the API; the browser only learns that it failed.
  await page.goto(`/github/callback?code=cli-code-1&state=${state}`);
  await expect(page).toHaveURL(/\/github\/cli\?result=failed$/);
  await expect(page.locator("[data-cli-github=failed]").getByRole("alert")).toContainText("could not be completed");
  await expect(page.locator("body")).not.toContainText("cli-code-1");
});

test("a CLI GitHub callback needs no session, and cancelled, denied or malformed ones end without connecting", async ({
  page,
}) => {
  const canceled = await cliFlow("cli-code-2", true);
  await page.goto(`/github/callback?code=cli-code-2&state=${canceled}`);
  await expect(page).toHaveURL(/\/github\/cli\?result=failed$/);
  expect((await cliState()).githubCliCalls).toHaveLength(1);

  // Without a dashboard session either: the flow state binds the CLI user, so it completes.
  const pending = await cliFlow("cli-code-3");
  await page.goto(`/github/callback?code=cli-code-3&state=${pending}`);
  await expect(page).toHaveURL(/\/github\/cli\?result=connected$/);

  // Ended before anything is sent: a provider error, a repeated parameter, a short state.
  const denied = await cliFlow("cli-code-4");
  await page.goto(`/github/callback?error=access_denied&error_description=nope%20%3Cb%3E&state=${denied}`);
  await expect(page).toHaveURL(/\/github\/cli\?result=denied$/);
  await expect(page.locator("body")).not.toContainText("nope");
  await page.goto(`/github/callback?code=cli-code-4&state=${denied}&state=${denied}`);
  await expect(page).toHaveURL(/\/github\/cli\?result=failed$/);
  await page.goto("/github/callback?code=cli-code-4&state=armada_cli_short");
  await expect(page).toHaveURL(/\/github\/cli\?result=failed$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/github-cli-failed-mobile.png" });
  expect((await cliState()).githubCliCalls).toHaveLength(2);
  expect(await connections()).toEqual([]);
});

test("a connected person sees who they are, and disconnecting removes only their own row", async ({ page }) => {
  await fetch(`${MOCK}/__test/github-connect`, {
    method: "POST",
    body: JSON.stringify({
      user: IDS.alice,
      login: "octocat",
      installations: [{ id: 50, account: "acme", account_type: "Organization", repository_selection: "selected" }],
    }),
  });
  await fetch(`${MOCK}/__test/github-connect`, {
    method: "POST",
    body: JSON.stringify({ user: IDS.bob, login: "bobcat" }),
  });
  await signIn(page, "alice@example.com", "/settings");
  const card = page.locator('[data-settings="github"]');
  await expect(card.getByText("@octocat")).toBeVisible();
  await expect(card.getByText("583231+octocat@users.noreply.github.com")).toBeVisible();
  await expect(card.getByText("Selected repositories")).toBeVisible();
  await expect(card.getByRole("link", { name: "Manage installation" })).toHaveAttribute(
    "href",
    "https://github.com/organizations/acme/settings/installations/50",
  );
  await expect(card.getByText("bobcat")).toHaveCount(0);
  expect(await page.content()).not.toContain("refresh_token_enc");

  await card.getByRole("button", { name: "Disconnect" }).click();
  await expect(card.locator("[data-github-state]")).toHaveAttribute("data-github-state", "not-connected");
  const rows = (await (await fetch(`${MOCK}/__test/github-connections`)).json()) as { login: string }[];
  expect(rows.map((row) => row.login)).toEqual(["bobcat"]);
});

test("a connection with no installation warns, and Connect sends the person to install the app", async ({ page }) => {
  await page.route("https://github.com/**", (route) => route.fulfill({ status: 200, body: "GitHub" }));
  await fetch(`${MOCK}/__test/github-installations`, { method: "POST", body: JSON.stringify({ installations: [] }) });
  await fetch(`${MOCK}/__test/github-connect`, {
    method: "POST",
    body: JSON.stringify({ user: IDS.alice, login: "octocat", installations: [] }),
  });
  await signIn(page, "alice@example.com", "/settings");
  const card = page.locator('[data-settings="github"]');
  await expect(card.locator("[data-github-installations='missing']")).toContainText("not installed");

  await card.getByRole("button", { name: "Disconnect" }).click();
  await expect(card.locator("[data-github-state]")).toHaveAttribute("data-github-state", "not-connected");

  const [request] = await Promise.all([
    page.waitForRequest((candidate) => candidate.url().startsWith("https://github.com/login/oauth/authorize")),
    card.getByRole("link", { name: "Connect GitHub" }).click(),
  ]);
  const state = new URL(request.url()).searchParams.get("state");
  const response = await page.goto(`/github/callback?code=good-code&state=${state}`, { waitUntil: "commit" });
  const urls: string[] = [];
  for (let seen = response?.request(); seen; seen = seen.redirectedFrom() ?? undefined) urls.push(seen.url());
  const install = urls.map((url) => new URL(url)).find((url) => url.pathname === "/apps/armada-tvc/installations/new");
  expect(install?.searchParams.get("state")).toBe(state);
  expect(await connections()).toEqual([]);

  await fetch(`${MOCK}/__test/github-installations`, {
    method: "POST",
    body: JSON.stringify({
      installations: [
        {
          id: 4242,
          app_id: 8675309,
          app_slug: "armada-tvc",
          account: { login: "octocat", type: "User" },
          repository_selection: "selected",
          target_type: "User",
        },
      ],
    }),
  });
  await page.goto(`/github/callback?code=good-code&state=${state}&installation_id=4242&setup_action=install`);
  await page.waitForURL("**/settings?github=connected");
  await expect(card.getByText("Selected repositories")).toBeVisible();
});

test("an install that started on GitHub connects a signed-in browser and stops when nobody is signed in", async ({
  page,
}) => {
  await page.goto("/github/callback?code=good-code&installation_id=4242&setup_action=install");
  await page.waitForURL("**/login?error=github_install");
  await expect(page.getByText("this browser is not signed in to Armada")).toBeVisible();
  expect(await connections()).toEqual([]);

  await signIn(page, "alice@example.com", "/settings");
  await page.goto("/github/callback?code=good-code&installation_id=4242&setup_action=update");
  await page.waitForURL("**/settings?github=connected");
  await expect(page.getByText("@octocat")).toBeVisible();
  const rows = await connections();
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("someone-else");
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
