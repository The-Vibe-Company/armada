import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("a signed-in browser confirms the terminal code and authorizes the CLI", { session: "alice" }, async ({
  app,
  screen,
}) => {
  await app.open("/cli-login?id=91550000-0000-4000-8000-000000000001");
  await expect(screen.getByRole("heading", "Authorize the Armada CLI")).toBeVisible();
  await expect(screen.getByText("12AB34CD", { exact: true })).toBeVisible();
  await expect(screen.getByText("ssh-workstation", { exact: true })).toBeVisible();
  await screen.getByRole("button", "Authorize", { exact: true }).tap();
  await expect(screen.getByText("CLI authorized. Return to your terminal.", { exact: true })).toBeVisible();
});
