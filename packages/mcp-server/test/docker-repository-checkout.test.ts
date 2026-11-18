import { expect, test } from "bun:test";
import { dockerRepositoryCheckout } from "../src/docker-repository-checkout.ts";

test("Docker checkout requests both histories and tracks the launch branch only after Git establishes a merge base", () => {
  const script = dockerRepositoryCheckout(
    [{ url: "https://github.com/example/project.git", branch: "feature/review", dir: "checkout" }],
    "/home/user",
  );

  // This is the shell contract sent to the guest. Git itself owns the ancestry calculation.
  expect(script).toContain("default_ref=$(git symbolic-ref HEAD)");
  expect(script).toContain('launch_ref="refs/heads/$branch"');
  expect(script).toContain(`default_tracking="refs/remotes/origin/\${default_ref#refs/heads/}"`);
  expect(script).toContain('launch_tracking="refs/remotes/origin/$branch"');
  expect(script).toMatch(/git fetch [^\n]+\+\$default_ref:\$default_tracking" "\+\$launch_ref:\$launch_tracking"/);
  expect(script).toMatch(
    /if git merge-base "\$default_tracking" "\$launch_tracking" >\/dev\/null; then\s+git config [^\n]+\s+git switch --track -c "\$branch" "\$launch_tracking"/,
  );
  expect(script).toContain('git fetch --no-tags --depth="$depth"');
  expect(script).toContain(
    "checkout_repository 'https://github.com/example/project.git' 'feature/review' '/home/user/checkout'\n" +
      "track_pushes '/home/user/checkout'",
  );
  expect(script).toContain('git config --local core.hooksPath "$own"');
  expect(script).toContain("remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'");
});
