import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createLocalNode } from "../src/index.ts";
import { repository } from "./support.ts";

const execute = promisify(execFile);
const root = process.argv[2];
assert(root, "fixture root is required");
const linked = process.argv[3] === "linked";

try {
  const main = await repository(root);
  const ignore = "# Repository-owned ignore rules\nnode_modules/\n";
  await writeFile(join(main, ".gitignore"), ignore);
  await execute("git", ["-C", main, "add", ".gitignore"]);
  await execute("git", [
    "-C",
    main,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Repository ignore rules",
  ]);
  const source = linked ? join(root, "chosen-checkout") : main;
  if (linked) await execute("git", ["-C", main, "worktree", "add", "--quiet", "-b", "chosen", source]);
  const node = createLocalNode({
    projects: { orchard: { root: source } },
    workspaceRoot: join(root, "legacy-workspaces"),
    transport: "pipe",
  });
  const workspaces = [];
  for (const ticket of ["CHECK-1", "CHECK-2"]) {
    const workspace = await node.prepare({
      project: "orchard",
      ticket,
      repository: main,
      branch: `worker-${ticket}`,
    });
    workspaces.push(workspace);
    assert.equal(workspace.path, join(source, ".armada", "worktrees", ticket));
    assert.equal(
      (await execute("git", ["-C", workspace.path, "branch", "--show-current"])).stdout.trim(),
      `worker-${ticket}`,
    );
    assert.equal(
      (await execute("git", ["-C", source, "check-ignore", `.armada/worktrees/${ticket}`])).stdout.trim(),
      `.armada/worktrees/${ticket}`,
    );
  }
  const exclude = resolve(
    source,
    (await execute("git", ["-C", source, "rev-parse", "--git-path", "info/exclude"])).stdout.trim(),
  );
  assert.equal(
    (await readFile(exclude, "utf8")).split("\n").filter((line) => line === "/.armada/worktrees/").length,
    1,
  );
  assert.equal(await readFile(join(source, ".gitignore"), "utf8"), ignore);
  assert(node.dispose);
  for (const workspace of workspaces) {
    await node.dispose(workspace);
    await assert.rejects(stat(workspace.path), /ENOENT/);
  }
} catch (error) {
  console.error(error);
  // Preserve Git's reason even when a runtime prints only the child_process stack.
  if (error && typeof error === "object" && "stderr" in error) console.error(String(error.stderr));
  process.exitCode = 1;
}
