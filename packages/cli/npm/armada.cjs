#!/usr/bin/env node
"use strict";

const { chmodSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { name, version } = require("../package.json");

const SUPPORTED = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

function fail(message) {
  process.stderr.write(`armada: ${message}\n`);
  process.exit(1);
}

const target = `${process.platform}-${process.arch}`;
if (!SUPPORTED.includes(target)) {
  fail(`no armada binary for ${target}. Supported: ${SUPPORTED.join(", ")}.`);
}

const platformPackage = `${name}-${target}`;
let binary;
try {
  binary = require.resolve(`${platformPackage}/bin/armada`);
} catch {
  fail(
    `${platformPackage}@${version} is not installed. It is an optional dependency of ${name}: ` +
      "reinstall without --omit=optional (or --no-optional), on this machine, so the lockfile picks this platform.",
  );
}

function run() {
  return spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
}

let result = run();
if (result.error && result.error.code === "EACCES") {
  chmodSync(binary, 0o755);
  result = run();
}
if (result.error) fail(`could not run ${binary}: ${result.error.message}`);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
