import { expect, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

const SECRET = "boat-personal-super-secret-key";

test("a personal hosting key is stored encrypted and never shown again", async ({ page }) => {
  await signIn(page, "alice@example.com", "/settings");
  const mine = page.locator('[data-credentials="user"]');
  await mine.getByLabel("Kind").selectOption("boat");
  await mine.getByLabel("Value", { exact: true }).fill(SECRET);
  await mine.getByRole("button", { name: "Save key" }).click();
  await expect(mine.getByText("boat.dev API key saved.")).toBeVisible();

  await expect(mine.getByRole("img", { name: "Value hidden" })).toHaveCount(1);
  await page.reload();
  expect(await page.content()).not.toContain(SECRET);
  await expect(mine.getByLabel("Value", { exact: true })).toHaveValue("");

  const stored = (await (await fetch(`${MOCK}/__test/credentials`)).json()) as { kind: string; value_enc: string }[];
  const row = stored.find((item) => item.kind === "boat");
  expect(row?.value_enc.startsWith("\\x")).toBe(true);
  // iv (12) + token + tag (16) bytes, as hex, and not the token itself.
  expect(row?.value_enc.length).toBe(2 + 2 * (12 + SECRET.length + 16));
  expect(row?.value_enc).not.toContain(Buffer.from(SECRET).toString("hex"));

  await mine.getByRole("button", { name: "Remove boat.dev API key" }).click();
  await expect(mine.getByRole("button", { name: "Remove boat.dev API key" })).toHaveCount(0);
});

test("a value with spaces is refused before anything is stored", async ({ page }) => {
  await signIn(page, "alice@example.com", "/settings");
  const mine = page.locator('[data-credentials="user"]');
  await mine.getByLabel("Value", { exact: true }).fill("two words");
  await mine.getByRole("button", { name: "Save key" }).click();
  await expect(mine.locator('p[role="alert"]')).toContainText("no spaces");
});

test("personal provider keys sit in Settings under the org's providers; Harness offers no provider key", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/settings");
  const providers = page.locator('[data-settings="providers"]');
  const personal = page.locator('[data-settings="personal-keys"]');
  await expect(providers).toBeVisible();
  await expect(personal.getByRole("heading", { name: "Your personal provider keys" })).toBeVisible();
  // Right after the organization's provider rows, before GitHub.
  const order = await page
    .locator("[data-settings]")
    .evaluateAll((cards) => cards.map((card) => card.getAttribute("data-settings")));
  expect(order).toEqual(["providers", "personal-keys", "github"]);
  await expect(
    personal.locator('[data-credentials="user"]').locator("li", { hasText: "boat.dev API key" }),
  ).toHaveCount(1);

  await page.goto("/harness");
  await expect(page.getByRole("heading", { name: "Harness", level: 1 })).toBeVisible();
  await expect(page.locator("[data-harness]")).toHaveCount(2);
  await expect(page.locator("[data-credentials]")).toHaveCount(0);
  await expect(page.locator("[data-modal-token]")).toHaveCount(0);
  await expect(page.getByText("boat.dev API key")).toHaveCount(0);
});

const MODAL_ID = "ak-e2eModalTokenId1234";
const MODAL_SECRET = "as-e2eModalTokenSecret5678";

test("a Modal token is saved from its two fields as one encrypted pair, never shown again, and removed", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/settings");
  const mine = page.locator('[data-credentials="user"]');
  await expect(mine.getByLabel("Kind")).toBeVisible();
  await expect(mine.getByLabel("Kind").locator("option", { hasText: "Modal" })).toHaveCount(0);
  const modal = mine.locator("[data-modal-token]");
  await modal.getByLabel("Token ID").fill(MODAL_ID);
  await modal.getByLabel("Token secret").fill(MODAL_SECRET);
  await modal.getByRole("button", { name: "Save Modal token" }).click();
  await expect(modal.getByText("Modal token saved.")).toBeVisible();
  await expect(modal.getByLabel("Token ID")).toHaveValue("");
  await expect(modal.getByLabel("Token secret")).toHaveValue("");

  const row = mine.locator("li", { hasText: "Modal token" });
  await expect(row.getByRole("img", { name: "Value hidden" })).toBeVisible();
  await page.reload();
  const html = await page.content();
  expect(html).not.toContain(MODAL_ID);
  expect(html).not.toContain(MODAL_SECRET);

  const stored = (await (await fetch(`${MOCK}/__test/credentials`)).json()) as { kind: string; value_enc: string }[];
  const sealed = stored.find((item) => item.kind === "modal");
  // iv (12) + the canonical {"token_id","token_secret"} JSON + tag (16) bytes, as hex; neither half in clear.
  const canonical = JSON.stringify({ token_id: MODAL_ID, token_secret: MODAL_SECRET });
  expect(sealed?.value_enc.length).toBe(2 + 2 * (12 + canonical.length + 16));
  expect(sealed?.value_enc).not.toContain(Buffer.from(MODAL_SECRET).toString("hex"));

  await mine.getByRole("button", { name: "Remove Modal token" }).click();
  await expect(mine.getByRole("button", { name: "Remove Modal token" })).toHaveCount(0);
});

test("a Modal token pair the server would refuse is reported without echoing it and nothing is stored", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/settings");
  const modal = page.locator('[data-credentials="user"] [data-modal-token]');
  // The halves swapped: the id must start with ak- and the secret with as-.
  await modal.getByLabel("Token ID").fill(MODAL_SECRET);
  await modal.getByLabel("Token secret").fill(MODAL_ID);
  await modal.getByRole("button", { name: "Save Modal token" }).click();
  await expect(modal.locator('p[role="alert"]')).toHaveText(
    "That is not a Modal token pair: the id starts with ak- and the secret with as-.",
  );
  await expect(modal.getByLabel("Token ID")).toHaveValue("");
  await expect(modal.getByLabel("Token secret")).toHaveValue("");
  const html = await page.content();
  expect(html).not.toContain(MODAL_ID);
  expect(html).not.toContain(MODAL_SECRET);
  const stored = (await (await fetch(`${MOCK}/__test/credentials`)).json()) as { kind: string }[];
  expect(stored.some((item) => item.kind === "modal")).toBe(false);
});

for (const email of ["alice@example.com", "bob@example.com"])
  test(`an org Modal token forged into the personal keys is refused for ${email.split("@")[0]}, never stored`, async ({
    page,
  }) => {
    await signIn(page, email, "/settings");
    await expect(page.locator('[data-credentials="user"] [data-modal-token]')).toBeVisible();
    await expect(page.locator('[data-credentials="Acme (org)"] [data-modal-token]')).toHaveCount(0);
    // Their own form, pointed at the org: hosting for an org is connected in Settings, checked by the server first.
    const modal = page.locator('[data-credentials="user"] [data-modal-token]');
    await modal.locator('input[name="scope"]').evaluate((input) => {
      (input as HTMLInputElement).value = "org";
    });
    await modal.locator('input[name="owner"]').evaluate((input) => {
      (input as HTMLInputElement).value = "00000000-0000-4000-8000-000000000010";
    });
    await modal.getByLabel("Token ID").fill(MODAL_ID);
    await modal.getByLabel("Token secret").fill(MODAL_SECRET);
    await modal.getByRole("button", { name: "Save Modal token" }).click();
    await expect(modal.locator('p[role="alert"]')).toHaveText(
      "Organization sandbox providers are managed in Settings.",
    );
    const stored = (await (await fetch(`${MOCK}/__test/credentials`)).json()) as { kind: string }[];
    expect(stored.some((item) => item.kind === "modal")).toBe(false);
  });
