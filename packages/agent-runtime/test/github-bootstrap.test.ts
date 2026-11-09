import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("actual Boat broker artifact consumes only private stdin and installs credential-free tool files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gh-bootstrap-"));
  let child: import("bun").Subprocess<"pipe", "pipe", "pipe"> | undefined;
  try {
    const root = join(directory, "private"),
      home = join(directory, "home"),
      bin = join(directory, "bin");
    await mkdir(root, { mode: 0o700 });
    await mkdir(home);
    await mkdir(bin);
    const gh = Bun.which("gh");
    if (!gh) throw Error("Actual gh required");
    const actualGh = join(bin, "source-gh"),
      actualGit = join(bin, "source-git");
    await writeFile(actualGh, `#!/bin/sh\nexec ${gh} "$@"\n`, { mode: 0o700 });
    await writeFile(actualGit, '#!/bin/sh\nexec /usr/bin/git "$@"\n', { mode: 0o700 });
    const capability = `armada_gh_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
    child = Bun.spawn([process.execPath, join(import.meta.dir, "../dist/github-boat-main.js")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(
      JSON.stringify({
        root,
        homes: [home],
        tools: { gh: actualGh, git: actualGit, ghWrapper: join(bin, "gh"), gitWrapper: join(bin, "git") },
        configuration: {
          version: 1,
          revision: "1",
          generation: "offline-physical",
          url: "https://armada.example/api/internal/github/credentials",
          capability,
          expiresAt: Date.now() + 60000,
        },
      }),
    );
    child.stdin.end();
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toBe("github_broker_ready\n");
    reader.releaseLock();
    const redacted = await fetch("http://private/redact", {
      unix: join(root, "redact.sock"),
      method: "POST",
      body: capability,
    });
    expect(await redacted.text()).toBe("***");
    expect((await fetch("http://private/registry", { unix: join(root, "redact.sock") })).status).toBe(403);
    for (const folder of [root, home, bin])
      for (const file of await readdir(folder, { withFileTypes: true })) {
        if (file.isFile())
          expect((await readFile(join(folder, file.name))).includes(Buffer.from(capability))).toBe(false);
      }
    expect((await readFile(join(bin, "gh"), "utf8")).includes(capability)).toBe(false);
  } finally {
    child?.kill();
    if (child) await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});
