import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITHUB_TOKEN_PATTERN, goldenScript, withGoldenDirs } from "../src/server.ts";

/** Pulls one named line-range out of the generated script, by its start and end markers (both included). */
function extract(script: string, startMarker: string, endMarker: string): string {
  const lines = script.split("\n");
  const start = lines.findIndex((line) => line.includes(startMarker));
  const end = lines.findIndex((line, index) => index >= start && line.includes(endMarker));
  if (start === -1 || end === -1) throw new Error(`could not find '${startMarker}'..'${endMarker}' in the script`);
  return lines.slice(start, end + 1).join("\n");
}

function fakeBin(dir: string, names: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const path = join(dir, name);
    const body =
      name === "npm"
        ? `#!/bin/sh
if [ "$1" = "install" ] && [ "$2" = "--global" ] && [ "$3" = "--prefix" ]; then mkdir -p "$4/bin"; printf '#!/bin/sh\necho PINNED\n' > "$4/bin/bun"; chmod +x "$4/bin/bun"; fi
echo "FAKE npm called with: $*"
exit 0
`
        : `#!/bin/sh
echo "FAKE ${name} called with: $*"
exit 0
`;
    writeFileSync(path, body, { mode: 0o755 });
  }
}

test("the inline check shares the exact tightened pattern with the independent scan", () => {
  const prepared = withGoldenDirs([{ owner: "acme", repo: "web", id: 1, installationId: 2, branch: "main" }]);
  const script = goldenScript(prepared);
  expect(script).toContain(GITHUB_TOKEN_PATTERN);
  expect(script).not.toContain("gh[suo]_[A-Za-z0-9_-]+");
});

test("real shell: the baseline tolerates a repo with no package.json, pins across repos, and installs claude/codex when missing", () => {
  const base = mkdtempSync(join(tmpdir(), "armada-baseline-"));
  try {
    const home = join(base, "home");
    const bin = join(base, "bin");
    mkdirSync(join(home, "nopin"), { recursive: true });
    mkdirSync(join(home, "haspin"), { recursive: true });
    writeFileSync(
      join(home, "haspin", "package.json"),
      JSON.stringify({ packageManager: "bun@9.9.9", devDependencies: { "@playwright/test": "2.0.0" } }),
    );
    fakeBin(bin, ["npm", "curl", "bunx", "bun"]);

    const prepared = withGoldenDirs([
      { owner: "acme", repo: "nopin", id: 1, installationId: 2, branch: "main" },
      { owner: "acme", repo: "haspin", id: 2, installationId: 2, branch: "main" },
    ]);
    const script = goldenScript(prepared).replace(/\/home\/user/g, home);
    const block = extract(script, 'bun_pin=""', "npm install --global @openai/codex");

    const result = spawnSync("/bin/bash", ["-euo", "pipefail", "-c", block], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FAKE npm called with: install --global --prefix");
    expect(result.stdout).toContain("bun@9.9.9");
    expect(result.stdout).toContain("@playwright/test@2.0.0");
    expect(result.stdout).toContain("FAKE npm called with: install --global @anthropic-ai/claude-code");
    expect(result.stdout).toContain("FAKE npm called with: install --global @openai/codex");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("real shell: pinned Bun persists for a fresh shell", () => {
  const base = mkdtempSync(join(tmpdir(), "armada-baseline-"));
  try {
    const home = join(base, "home");
    const bin = join(base, "bin");
    mkdirSync(join(home, "web"), { recursive: true });
    writeFileSync(join(home, "web", "package.json"), JSON.stringify({ packageManager: "bun@9.9.9" }));
    fakeBin(bin, ["npm", "bunx", "bun", "claude", "codex"]);
    // Mimic npm's installed binary without touching host globals.
    mkdirSync(join(home, ".bun-npm", "bin"), { recursive: true });
    writeFileSync(join(home, ".bun-npm", "bin", "bun"), "#!/bin/sh\necho PINNED\n", { mode: 0o755 });
    const prepared = withGoldenDirs([{ owner: "acme", repo: "web", id: 1, installationId: 2, branch: "main" }]);
    const block = extract(
      goldenScript(prepared).replace(/\/home\/user/g, home),
      'bun_pin=""',
      "npm install --global @openai/codex",
    );
    expect(
      spawnSync("/bin/bash", ["-euo", "pipefail", "-c", block], {
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
        encoding: "utf8",
      }).status,
    ).toBe(0);
    // An old system Bun comes first, matching provider native exec PATH precedence.
    const old = bin;
    const fresh = spawnSync("/bin/sh", ["-c", "bun"], {
      env: { PATH: `${old}:${home}/.local/bin:${home}/.bun/bin:/usr/bin:/bin`, HOME: home },
      encoding: "utf8",
    });
    expect(fresh.status).toBe(0);
    expect(fresh.stdout).toContain("PINNED");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test.each(["2.1.319", "2.1.322"])(
  "real shell: baseline upgrades old Claude but preserves the current pin and installed Codex (%s)",
  (version) => {
    const base = mkdtempSync(join(tmpdir(), "armada-baseline-"));
    try {
      const home = join(base, "home");
      const bin = join(base, "bin");
      mkdirSync(join(home, "web"), { recursive: true });
      fakeBin(bin, ["npm", "curl", "bunx", "bun", "claude", "codex"]);

      writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
      const prepared = withGoldenDirs([{ owner: "acme", repo: "web", id: 1, installationId: 2, branch: "main" }]);
      const script = goldenScript(prepared).replace(/\/home\/user/g, home);
      const block = extract(script, 'bun_pin=""', "npm install --global @openai/codex");

      const result = spawnSync("/bin/bash", ["-euo", "pipefail", "-c", block], {
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      if (version === "2.1.322") expect(result.stdout).not.toContain("claude-code");
      else expect(result.stdout).toContain("install --global @anthropic-ai/claude-code@2.1.322");
      expect(result.stdout).not.toContain("@openai/codex");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

/** Just the cleanup trap, lifted verbatim out of the real build script, for isolated shell tests. */
function cleanupScript(): string {
  const prepared = withGoldenDirs([{ owner: "acme", repo: "web", id: 1, installationId: 2, branch: "main" }]);
  const script = goldenScript(prepared);
  const trap = extract(script, "cleanup_armada_key()", "trap 'cleanup_armada_key' EXIT");
  return `set -euo pipefail\n${trap}\n`;
}

test("real shell: cleanup removes only the exact Armada key line and preserves unrelated ones", () => {
  const base = mkdtempSync(join(tmpdir(), "armada-cleanup-"));
  try {
    const home = join(base, "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    const key = "ssh-ed25519 AAAAARMADA armada-ephemeral";
    writeFileSync(
      join(home, ".ssh", "authorized_keys"),
      ["ssh-ed25519 AAAABOAT boat-management-key", key, "ssh-ed25519 AAAAOTHER another-key", ""].join("\n"),
    );
    const result = spawnSync("/bin/bash", ["-c", cleanupScript()], {
      env: { PATH: process.env.PATH ?? "", HOME: home, ARMADA_SSH_PUBLIC_KEY: key },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const text = readFileSync(join(home, ".ssh", "authorized_keys"), "utf8");
    expect(text).toContain("boat-management-key");
    expect(text).toContain("another-key");
    expect(text).not.toContain("armada-ephemeral");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("real shell: cleanup removes the file's only line without error", () => {
  const base = mkdtempSync(join(tmpdir(), "armada-cleanup-"));
  try {
    const home = join(base, "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    const key = "ssh-ed25519 AAAAARMADA armada-ephemeral";
    writeFileSync(join(home, ".ssh", "authorized_keys"), `${key}\n`);
    const result = spawnSync("/bin/bash", ["-c", cleanupScript()], {
      env: { PATH: process.env.PATH ?? "", HOME: home, ARMADA_SSH_PUBLIC_KEY: key },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("real shell: a genuine cleanup failure fails closed and never overwrites authorized_keys", () => {
  const base = mkdtempSync(join(tmpdir(), "armada-cleanup-"));
  try {
    const home = join(base, "home");
    // authorized_keys is a directory, not a file: grep -F against it is a real I/O error, not "no match".
    mkdirSync(join(home, ".ssh", "authorized_keys"), { recursive: true });
    const key = "ssh-ed25519 AAAAARMADA armada-ephemeral";
    const result = spawnSync("/bin/bash", ["-c", cleanupScript()], {
      env: { PATH: process.env.PATH ?? "", HOME: home, ARMADA_SSH_PUBLIC_KEY: key },
      encoding: "utf8",
    });
    expect(result.status).toBe(96);
    expect(result.stdout).not.toContain(key);
    expect(result.stderr).not.toContain(key);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("clone helper only serves github HTTPS and leaves no token config", () => {
  const token = "ghp_" + "Z".repeat(36);
  const prepared = withGoldenDirs([{ owner: "acme", repo: "web", id: 1, installationId: 2, branch: "main" }]);
  const script = goldenScript(prepared);
  const helper = script.match(/export GIT_CONFIG_VALUE_0='([^']+)'/)?.[1];
  expect(helper).toBeDefined();
  const accepted = helper?.includes("protocol=https") && helper.includes("host=github.com");
  const denied = helper?.includes("*) exit 1");
  expect(accepted).toBe(true);
  expect(denied).toBe(true);
  expect(helper).not.toContain(token);
  expect(script).not.toContain("git config --global credential.helper");
  expect(script).toContain("unset GIT_CONFIG_COUNT");
});

test("real shell: pinned Bun replaces an image binary in a non-writable PATH directory", () => {
  const base = mkdtempSync(join(tmpdir(), "armada-baseline-permissions-"));
  const home = join(base, "home");
  const bin = join(base, "bin");
  const system = join(base, "system");
  try {
    mkdirSync(join(home, "web"), { recursive: true });
    writeFileSync(join(home, "web", "package.json"), JSON.stringify({ packageManager: "bun@9.9.9" }));
    fakeBin(bin, ["npm", "bunx", "claude", "codex"]);
    fakeBin(system, ["bun"]);
    // Model the immutable image's PATH directory, not a writable fake binary directory.
    expect(spawnSync("chmod", ["555", system]).status).toBe(0);
    const bashEnv = join(base, "bash-env");
    const events = join(base, "events");
    // The real image resolves Bun at this fixed privileged path. Map only that path
    // to our owned readonly fixture; no process receives a host-system write target.
    writeFileSync(
      bashEnv,
      `command() {
  if [ "$#" -eq 2 ] && [ "$1" = -v ] && [ "$2" = bun ]; then printf '%s\\n' /usr/local/bin/bun;
  else builtin command "$@"; fi
}
ln() {
  if [ "$#" -eq 4 ] && [ "$1" = -sf ] && [ "$2" = -- ] && [ "$3" = "$HOME/.bun-npm/bin/bun" ] && [ "$4" = /usr/local/bin/bun ]; then
    printf 'unprivileged-denied\\n' >> "$ARMADA_TEST_EVENTS"
    return 1
  fi
  case "\${!#}" in /usr/*|/bin/*) return 95 ;; esac
  builtin command ln "$@"
}
`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(bin, "sudo"),
      `#!/bin/sh
set -eu
[ "$#" -eq 6 ] && [ "$1" = -n ] && [ "$2" = ln ] && [ "$3" = -sf ] && [ "$4" = -- ] && [ "$5" = "$HOME/.bun-npm/bin/bun" ] && [ "$6" = /usr/local/bin/bun ] || exit 95
printf 'privileged-replacement\\n' >> "$ARMADA_TEST_EVENTS"
chmod 755 "$ARMADA_TEST_IMAGE_BIN"
/bin/ln -sf -- "$5" "$ARMADA_TEST_IMAGE_BIN/bun"
chmod 555 "$ARMADA_TEST_IMAGE_BIN"
`,
      { mode: 0o700 },
    );
    const prepared = withGoldenDirs([{ owner: "acme", repo: "web", id: 1, installationId: 2 }]);
    const block = extract(
      goldenScript(prepared).replace(/\/home\/user/g, home),
      'bun_pin=""',
      "npm install --global @openai/codex",
    );
    const result = spawnSync("/bin/bash", ["-euo", "pipefail", "-c", block], {
      env: {
        PATH: `${system}:${bin}:/usr/bin:/bin`,
        HOME: home,
        GIT_CONFIG_GLOBAL: "/dev/null",
        BASH_ENV: bashEnv,
        ARMADA_TEST_EVENTS: events,
        ARMADA_TEST_IMAGE_BIN: system,
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(readFileSync(events, "utf8")).toBe("unprivileged-denied\nprivileged-replacement\n");
    const fresh = spawnSync("/bin/sh", ["-c", "bun"], {
      env: { PATH: `${system}:${bin}:/usr/bin:/bin`, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" },
      encoding: "utf8",
    });
    expect(fresh.status).toBe(0);
    expect(fresh.stdout).toContain("PINNED");
  } finally {
    spawnSync("chmod", ["755", system]);
    rmSync(base, { recursive: true, force: true });
  }
});
