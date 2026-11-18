import { expect, test } from "bun:test";
import { dockerRepositoryCheckout } from "../src/docker-repository-checkout.ts";

test("Docker checkout requests both histories and tracks the launch branch only after Git establishes a merge base", () => {
  const script = dockerRepositoryCheckout(
    [{ url: "https://github.com/example/project.git", branch: "feature/review", dir: "checkout" }],
    "/home/user",
  );

  // This is the shell contract sent to the guest. Git itself owns the ancestry calculation.
  expect(script).toMatch(/git clone --depth=3 --single-branch --no-checkout/);
  expect(script).toMatch(/for depth in 3 32 128 512; do/);
  expect(script).toMatch(/git fetch [^\n]+\+\$default_ref:\$default_tracking" "\+\$launch_ref:\$launch_tracking"/);
  expect(script).toMatch(
    /if git merge-base "\$default_tracking" "\$launch_tracking" >\/dev\/null; then\s+git config [^\n]+\s+git switch --track -c "\$branch" "\$launch_tracking"/,
  );
  expect(script).toContain("remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'");
});
