import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("an organization admin connects, tests and disables Langfuse", { session: "alice" }, async ({ app, screen }) => {
  await app.open("/orgs/00000000-0000-4000-8000-000000000010");
  await screen.getByRole("button", "Connect Langfuse", { exact: true }).tap();
  await screen.getByRole("textbox", "Public key", { exact: true }).fill("fixture_public");
  await screen.getByLabel("Secret key", { exact: true }).fill("fixture_secret");
  await screen.getByRole("button", "Connect and start exporting", { exact: true }).tap();
  await expect(screen.getByRole("switch", "Export traces")).toBeVisible();
  await screen.getByRole("button", "Test the connection", { exact: true }).tap();
  await expect(screen.getByRole("status")).toContainText("Langfuse accepted these keys.");
  await screen.getByRole("switch", "Export traces").tap();
  await expect(screen.getByText("Export is off", { exact: true })).toBeVisible();
  await screen.getByRole("button", "Edit", { exact: true }).tap();
  await expect(screen.getByText("Stored · value hidden")).toBeVisible();
});
