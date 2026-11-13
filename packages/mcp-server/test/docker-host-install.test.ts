import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@armada/core";
import { createDockerHostInstallRoute } from "../src/docker-host-install.ts";

// The public route is the trust boundary: installer must pin the artifact served by this build.
test("installer publishes both build digests without credentials and refuses missing artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "host-installer-"));
  try {
    const route = createDockerHostInstallRoute(dir, "https://armada.example");
    const request = new Request("http://internal:8080/install-host.sh");
    expect((await route(request))?.status).toBe(503);
    await Bun.write(join(dir, "docker-host.json"), JSON.stringify({ x64: "a".repeat(64), arm64: "b".repeat(64) }));
    const response = await route(request);
    expect(response?.status).toBe(200);
    const script = await response?.text();
    expect(script).toContain("x86_64) digest=" + "a".repeat(64));
    expect(script).toContain("aarch64|arm64) digest=" + "b".repeat(64));
    expect(script).toContain("sha256sum --check --status");
    expect(script).toContain("token=$2");
    expect(Bun.spawnSync(["sh", "-n"], { stdin: new TextEncoder().encode(script) }).exitCode).toBe(0);
    expect((await route(new Request(request.url, { method: "POST" })))?.status).toBe(405);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Execute the real POSIX installer with machine tools replaced, no network/service or sleep.
// This boundary owns digest-before-execution, token-on-stdin and connected confirmation.
test("one-line installer verifies bytes, delivers the one-use token privately and confirms a poll", async () => {
  const { createHash } = await import("node:crypto");
  const { mkdir, readFile, writeFile, symlink } = await import("node:fs/promises");
  const home = await mkdtemp(join(tmpdir(), "host-one-click-"));
  try {
    const tools = join(home, "tools");
    await mkdir(tools);
    // Hermetic PATH: do not discover the machine's real npm/npx in no-runtime cases.
    for (const command of [
      "sha256sum",
      "base64",
      "grep",
      "install",
      "mkdir",
      "mktemp",
      "rm",
      "chmod",
      "cat",
      "cp",
      "touch",
      "id",
    ])
      await symlink(`/usr/bin/${command}`, join(tools, command));
    const artifact = join(home, "artifact");
    const host =
      '#!/bin/sh\ncase "$1" in install) cat > "$HOME/registration" ;; status) printf \'{"registered":true,"connected":true,"hostId":"22222222-2222-4222-8222-222222222222"}\\n\' ;; *) exit 1 ;; esac\n';
    await writeFile(artifact, host);
    const digest = createHash("sha256").update(host).digest("hex");
    await Bun.write(join(home, "docker-host.json"), JSON.stringify({ x64: digest, arm64: digest }));
    for (const [name, body] of Object.entries({
      uname: 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac',
      docker: "exit 0",
      systemctl: 'case "$*" in *restart*) touch "$HOME/restarted" ;; esac',
      loginctl: 'case "$1" in show-user) echo yes ;; esac',
      curl: 'for arg do target=$arg; done; cp "$FIXTURE_ARTIFACT" "$target"',
    }))
      await writeFile(join(tools, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    const route = createDockerHostInstallRoute(home, "https://armada.example");
    const script = await (await route(new Request("http://internal/install-host.sh")))!.text();
    const token = "b".repeat(64);
    const run = (value: string) =>
      Bun.spawnSync(["/bin/sh", "-s", "--", "--token", value], {
        stdin: new TextEncoder().encode(script),
        env: { ...process.env, HOME: home, PATH: tools, FIXTURE_ARTIFACT: artifact },
      });
    expect(run("bad").exitCode).not.toBe(0);
    // Corrupt bytes must not be installed or executed.
    await writeFile(artifact, host + "# corrupt\n");
    expect(run(token).exitCode).not.toBe(0);
    expect(await Bun.file(join(home, "registration")).exists()).toBe(false);
    await writeFile(artifact, host);
    const result = run(token);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("connected");
    expect(result.stdout.toString()).toContain("Node is not required");
    expect(result.stdout.toString()).toContain(`npm install -g @the-vibe-company/armada@${VERSION}`);
    expect(result.stdout.toString() + result.stderr.toString()).not.toContain(token);
    expect((await readFile(join(home, "registration"), "utf8")).trim()).toBe(token);
    // Reusing a healthy registration must not exchange the fresh token.
    const reused = run("c".repeat(64));
    expect(reused.exitCode).toBe(0);
    expect(reused.stdout.toString()).toContain("Keeping the existing registration");
    expect(reused.stdout.toString()).toContain("22222222-2222-4222-8222-222222222222");
    expect((await readFile(join(home, "registration"), "utf8")).trim()).toBe(token);

    // A disconnected registration is restarted, not replaced.
    await writeFile(
      join(home, ".local/bin/armada-docker-host"),
      `#!/bin/sh
if [ -f "$HOME/restarted" ]; then
  echo '{"registered":true,"connected":true}'
else
  echo '{"registered":true,"connected":false,"hostId":"22222222-2222-4222-8222-222222222222"}'
fi
`,
      { mode: 0o700 },
    );
    const restarted = run("e".repeat(64));
    expect(restarted.exitCode).toBe(0);
    expect(restarted.stdout.toString()).toContain("Restarting the existing user service");
    expect((await readFile(join(home, "registration"), "utf8")).trim()).toBe(token);
    // An abandoned download with no registration can be replaced.
    await writeFile(
      join(home, ".local/bin/armada-docker-host"),
      `#!/bin/sh
echo '{"registered":false,"connected":false}'
`,
      { mode: 0o700 },
    );
    const replaced = run("d".repeat(64));
    expect(replaced.exitCode).toBe(0);
    expect(replaced.stdout.toString()).toContain("Replacing the unregistered host binary");
    expect((await readFile(join(home, "registration"), "utf8")).trim()).toBe("d".repeat(64));
    // Package runners receive only the pinned package/command, with the token on stdin.
    const runner = `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/runner-args"
cat > "$HOME/runner-stdin"
`;
    await writeFile(join(tools, "bun"), runner, { mode: 0o700 });
    const viaBun = run("e".repeat(64));
    expect(viaBun.exitCode).toBe(0);
    expect(await readFile(join(home, "runner-args"), "utf8")).toBe(
      `x\n--bun\n@the-vibe-company/armada@${VERSION}\nhost\ninstall\n--server\nhttps://armada.example\n`,
    );
    expect((await readFile(join(home, "runner-stdin"), "utf8")).trim()).toBe("e".repeat(64));
    expect(viaBun.stdout.toString()).toContain(`bun add -g @the-vibe-company/armada@${VERSION}`);
    await rm(join(tools, "bun"));
    await writeFile(join(tools, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(join(tools, "npx"), runner, { mode: 0o700 });
    const viaNpx = run("f".repeat(64));
    expect(viaNpx.exitCode).toBe(0);
    expect(await readFile(join(home, "runner-args"), "utf8")).toBe(
      `-y\n@the-vibe-company/armada@${VERSION}\nhost\ninstall\n--server\nhttps://armada.example\n`,
    );
    expect((await readFile(join(home, "runner-stdin"), "utf8")).trim()).toBe("f".repeat(64));
    expect(viaNpx.stdout.toString()).not.toContain("Install the armada command on this machine? [y/N]");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
