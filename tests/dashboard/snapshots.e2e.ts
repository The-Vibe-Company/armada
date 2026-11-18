import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { e2eFixture, fixtureOrigin } from "../../scripts/fixture-ports.ts";

const mock = fixtureOrigin(e2eFixture.mockPort);
async function configure(path: string, body: object) {
  const response = await fetch(`${mock}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Fixture configuration failed: ${path} (${response.status})`);
}

async function ensureModal(orgId: string) {
  const response = await fetch(`${mock}/__test/credentials`);
  if (!response.ok) throw new Error("Could not read fixture provider configuration");
  const rows = (await response.json()) as { kind: string; owner_id: string }[];
  if (!rows.some((row) => row.kind === "modal" && row.owner_id === orgId))
    await configure("accounts", {
      seed: [
        {
          id: `${orgId.slice(0, -12)}000000001${orgId.slice(-3)}`,
          kind: "modal",
          scope: "org",
          owner_id: orgId,
          value_enc: "\\x0102",
        },
      ],
    });
}
async function ensureGitHub() {
  const user = "00000000-0000-4000-8000-000000000001";
  const response = await fetch(`${mock}/__test/github-connections`);
  if (!response.ok) throw new Error("Could not read fixture GitHub configuration");
  const rows = (await response.json()) as { user_id: string }[];
  if (!rows.some((row) => row.user_id === user)) await configure("github-connect", { user, login: "fixture_user" });
}

for (const org of [
  { session: "alice", name: "Acme", id: "00000000-0000-4000-8000-000000000010" },
  { session: "large", name: "Large", id: "00000000-0000-4000-8000-000000000014" },
]) {
  test(`${org.name}: snapshot filters and in-form capacity blockers`, { session: org.session }, async ({
    app,
    screen,
    browser,
  }) => {
    // Existing mock controls configure a connected Modal account, never a real provider credential.
    await ensureModal(org.id);
    await app.open("/snapshots");
    await expect(screen.getByRole("button", /^All/)).toHaveAttribute("aria-pressed", "true");
    await screen.getByRole("button", /^Modal \d/).tap();
    await expect(browser.locator('li[data-golden-provider="boat"]')).toHaveCount(0);
    await screen.getByRole("button", /^All/).tap();
    await screen.getByRole("button", "New snapshot", { exact: true }).tap();
    const dialog = screen.getByRole("dialog", "New snapshot");
    await dialog.getByRole("textbox", "Snapshot name").fill("capacity-check");
    await dialog.getByRole("textbox", "Repository 1").fill("example/fixture");
    await expect(dialog).toContainText("the limit is reached");
    await expect(dialog.getByRole("button", "Build snapshot", { exact: true })).toBeDisabled();
    await dialog.getByRole("button", "Modal cloud", { exact: true }).tap();
    await expect(dialog.getByRole("textbox", "Snapshot name")).toHaveValue("capacity-check");
    if (org.session === "large") {
      await expect(dialog.getByRole("button", /Offline spare workstation/)).toBeDisabled();
      await dialog.getByRole("button", /^Docker host Large platform/).tap();
      const hostForm = browser
        .locator("form")
        .filter({ has: screen.getByRole("textbox", "Snapshot name", { visible: true }) });
      await expect(hostForm).toContainText("Where it is built and who sees it are permanent");
      await hostForm.getByRole("button", /^Who sees it:/).tap();
      await expect(screen.getByRole("option", /everyone in the organization/)).toHaveAttribute("aria-disabled", "true");
    }
  });

  for (const provider of ["Boat", "Modal"]) {
    test(`${org.name}: build a private ${provider} snapshot`, { session: org.session }, async ({ app, screen }) => {
      await ensureModal(org.id);
      await ensureGitHub();
      await configure("capabilities", { provider: "boat", maxGoldens: null });
      try {
        const name = `journey-${org.name.toLowerCase()}-${provider.toLowerCase()}`;
        await app.open("/snapshots");
        await screen.getByRole("button", "New snapshot", { exact: true }).tap();
        const dialog = screen.getByRole("dialog", "New snapshot");
        await dialog.getByRole("button", `${provider} cloud`, { exact: true }).tap();
        await dialog.getByRole("textbox", "Snapshot name").fill(name);
        await dialog.getByRole("button", "only you", { exact: true }).tap();
        await dialog.getByRole("textbox", "Repository 1").fill("example/fixture");
        await dialog.getByRole("button", "Build snapshot", { exact: true }).tap();
        await expect(dialog).toContainText(`${name} is ready`);
        await dialog.getByRole("link", "View snapshots").tap();
        await expect(screen.getByRole("link", name, { exact: true })).toBeVisible();
        const row = screen.getByRole("listitem").filter({ has: screen.getByRole("link", name, { exact: true }) });
        await expect(row).toContainText(`${provider} cloud`);
        await expect(row).toContainText("Private");
      } finally {
        await configure("capabilities", { provider: "boat", maxGoldens: 1 });
      }
    });
  }
}
