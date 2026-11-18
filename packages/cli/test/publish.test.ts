import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../../scripts/publish-npm.sh");
const version = "2.0.1";
const main = "@the-vibe-company/armada";
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const platforms = targets.map((target) => `${main}-${target}`);
const sdkPackage = "@the-vibe-company/armada-sdk";

function publish(mode: string, publishRelease = true, sdk = false) {
  const root = mkdtempSync(join(tmpdir(), "armada-publish-"));
  try {
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "dist/tarballs"), { recursive: true });
    for (const name of [...platforms, main, ...(sdk ? [sdkPackage] : [])]) {
      const short = name === sdkPackage ? "sdk" : (name.split("/")[1] as string);
      mkdirSync(join(root, "dist/npm", short), { recursive: true });
      writeFileSync(join(root, "dist/npm", short, "package.json"), JSON.stringify({ name, version }));
      writeFileSync(join(root, "dist/tarballs", `${name.slice(1).replace("/", "-")}-${version}.tgz`), name);
    }
    if (mode === "overlap") Bun.spawnSync(["mkfifo", join(root, "handshake")]);
    writeFileSync(
      join(root, "bin/npm"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TEST_ROOT/events"
case "$1" in
  view) [ "$MODE" = already-present ] ;;
  publish)
    # This upload completes only after another platform has started its registry check.
    # Open the FIFO before checking the marker so a signal sent in between is never lost.
    # The bounded read is only a deadlock guard: a serial script fails instead of hanging.
    if [ "$MODE" = overlap ] && [[ "$2" = *darwin-arm64* ]]; then
      exec 3<> "$TEST_ROOT/handshake"
      [ -f "$TEST_ROOT/check-started" ] || read -r -t 5 _ <&3 || exit 1
    fi
    exit 0
    ;;
  pack)
    spec="$2"
    file="\${spec%@*}"
    file="\${file#@}"
    file="\${file//\\//-}-$VERSION.tgz"
    while [ "$1" != --pack-destination ]; do shift; done
    destination="$2"
    if [ "$MODE" = unavailable ]; then exit 1; fi
    if [ "$MODE" = overlap ] && [[ "$file" = *linux-x64* ]]; then
      : > "$TEST_ROOT/check-started"
      # A read-write open never blocks, even when no upload is waiting any more.
      echo go 1<> "$TEST_ROOT/handshake"
    fi
    if [ "$MODE" = independent-delay ]; then
      countfile="$TEST_ROOT/count-$file"
      count=0
      if [ -f "$countfile" ]; then IFS= read -r count < "$countfile"; fi
      count=$((count + 1))
      echo "$count" > "$countfile"
      if [ "$count" -le 5 ]; then exit 1; fi
    fi
    if [ "$MODE" = delayed ] && [ ! -f "$TEST_ROOT/retried-$file" ]; then
      : > "$TEST_ROOT/retried-$file"
      exit 1
    fi
    # Fixtures contain one package name without a trailing newline.
    printf '%s' "$(< "$TEST_ROOT/dist/tarballs/$file")" > "$destination/$file"
    if [ "$MODE" = corrupt ] || [ "$MODE" = already-present ]; then echo original-release >> "$destination/$file"; fi
    echo "$file"
    ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(join(root, "bin/sleep"), '#!/bin/sh\necho "sleep $*" >> "$TEST_ROOT/events"\n', {
      mode: 0o755,
    });
    const result = Bun.spawnSync(["bash", script], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}/bin:${process.env.PATH}`,
        TEST_ROOT: root,
        VERSION: version,
        DIST_TAG: "latest",
        PUBLISH: String(publishRelease),
        MODE: mode,
        NPM_PUBLISH_WAIT_SECONDS: "8",
        NPM_PUBLISH_POLL_SECONDS: "1",
      },
    });
    return {
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      events: readFileSync(join(root, "events"), "utf8").trim().split("\n"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.each(["delayed", "independent-delay"])(
  "publication waits for each retrievable platform tarball before publishing the launcher (%s)",
  (mode) => {
    const result = publish(mode);
    expect(result.exitCode).toBe(0);
    const mainPublish = result.events.findIndex((event) =>
      event.startsWith(`publish dist/tarballs/the-vibe-company-armada-${version}.tgz `),
    );
    expect(mainPublish).toBeGreaterThan(-1);
    for (const name of platforms) {
      const attempts = result.events.flatMap((event, index) =>
        event.startsWith(`pack ${name}@${version} `) ? [index] : [],
      );
      expect(attempts.length).toBe(mode === "delayed" ? 2 : 6);
      expect(attempts.at(-1)).toBeLessThan(mainPublish);
    }
    expect(result.events.some((event) => event.startsWith("sleep "))).toBe(true);
    for (const event of result.events.filter((event) => event.startsWith("publish "))) {
      expect(event).toContain("--access public --tag latest --provenance");
    }
  },
);

test("each platform starts its registry check without waiting for the other uploads", () => {
  // darwin-arm64's upload blocks until linux-x64 starts its registry check.
  const result = publish("overlap");
  expect(result.exitCode).toBe(0);
  const mainPublish = result.events.findIndex((event) =>
    event.startsWith(`publish dist/tarballs/the-vibe-company-armada-${version}.tgz `),
  );
  expect(mainPublish).toBeGreaterThan(-1);
  for (const name of platforms) {
    const check = result.events.findLastIndex((event) => event.startsWith(`pack ${name}@${version} `));
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(mainPublish);
  }
});

for (const mode of ["unavailable", "corrupt"]) {
  test(`publication refuses the launcher when platform tarballs are ${mode}`, () => {
    const result = publish(mode);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(mode === "corrupt" ? "differs" : "Timed out");
    expect(
      result.events.some((event) => event.startsWith(`publish dist/tarballs/the-vibe-company-armada-${version}.tgz `)),
    ).toBe(false);
  });
}

test("recovery retrieves existing artifacts even when the rebuild differs", () => {
  const result = publish("already-present");
  expect(result.exitCode).toBe(0);
  expect(result.events.filter((event) => event.startsWith("publish "))).toEqual([]);
  expect(result.events.filter((event) => event.startsWith("pack ")).length).toBe(platforms.length);
});

test("dry runs publish every staged tarball without querying registry availability", () => {
  const result = publish("unavailable", false);
  expect(result.exitCode).toBe(0);
  expect(result.events.length).toBe(platforms.length + 1);
  for (const event of result.events) {
    expect(event).toStartWith("publish ");
    expect(event).toContain("--dry-run");
  }
});

test("a staged SDK is published after the launcher", () => {
  const result = publish("delayed", true, true);
  expect(result.exitCode).toBe(0);
  expect(result.events.filter((event) => event.startsWith("publish ")).slice(-2)).toEqual([
    `publish dist/tarballs/the-vibe-company-armada-${version}.tgz --access public --tag latest --provenance`,
    `publish dist/tarballs/the-vibe-company-armada-sdk-${version}.tgz --access public --tag latest --provenance`,
  ]);
});
