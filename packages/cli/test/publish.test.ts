import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../../scripts/publish-npm.sh");
const version = "2.0.1";
const main = "@the-vibe-company/armada";
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const platforms = targets.map((target) => `${main}-${target}`);

function publish(mode: string, publishRelease = true) {
  const root = mkdtempSync(join(tmpdir(), "armada-publish-"));
  try {
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "dist/tarballs"), { recursive: true });
    for (const name of [...platforms, main]) {
      const short = name.split("/")[1] as string;
      mkdirSync(join(root, "dist/npm", short), { recursive: true });
      writeFileSync(join(root, "dist/npm", short, "package.json"), JSON.stringify({ name, version }));
      writeFileSync(join(root, "dist/tarballs", `${name.slice(1).replace("/", "-")}-${version}.tgz`), name);
    }
    writeFileSync(
      join(root, "bin/npm"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TEST_ROOT/events"
case "$1" in
  view) [ "$MODE" = already-present ] ;;
  publish) exit 0 ;;
  pack)
    spec="$2"
    file="\${spec%@*}"
    file="\${file#@}"
    file="\${file//\\//-}-$VERSION.tgz"
    while [ "$1" != --pack-destination ]; do shift; done
    destination="$2"
    if [ "$MODE" = unavailable ]; then exit 1; fi
    if [ "$MODE" = delayed ] && [ ! -f "$TEST_ROOT/retried-$file" ]; then
      touch "$TEST_ROOT/retried-$file"
      exit 1
    fi
    cp "$TEST_ROOT/dist/tarballs/$file" "$destination/$file"
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

test("publication waits for retrievable platform tarballs before publishing the launcher", () => {
  const result = publish("delayed");
  expect(result.exitCode).toBe(0);
  const mainPublish = result.events.findIndex((event) =>
    event.startsWith(`publish dist/tarballs/the-vibe-company-armada-${version}.tgz `),
  );
  expect(mainPublish).toBeGreaterThan(-1);
  for (const name of platforms) {
    const attempts = result.events.flatMap((event, index) =>
      event.startsWith(`pack ${name}@${version} `) ? [index] : [],
    );
    expect(attempts.length).toBe(2);
    expect(attempts[1]).toBeLessThan(mainPublish);
  }
  expect(result.events.some((event) => event.startsWith("sleep "))).toBe(true);
  for (const event of result.events.filter((event) => event.startsWith("publish "))) {
    expect(event).toContain("--access public --tag latest --provenance");
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
