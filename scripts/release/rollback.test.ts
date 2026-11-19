import { expect, test } from "bun:test";
import { rollbackRefusal } from "./rollback";

const current = { tag: "v3.1.0", sha: "a".repeat(40) };
const previous = { tag: "v3.0.0", sha: "b".repeat(40) };
const migration = "20261119000000";

function receipt(release: typeof current) {
  return {
    version: release.tag.slice(1),
    sha: release.sha,
    previousVersion: "3.0.0",
    serverDeployment: "server",
    dashboardDeployment: "dashboard",
    migrations: [],
    productionMigrationHistory: [],
    protocolBump: { runtime: { from: 1, to: 1 }, dockerHost: { from: 2, to: 2 } },
    surfaceBreak: [],
  };
}

const currentAsset = receipt(current);
const previousAsset = receipt(previous);
const health = { ok: true, version: "3.1.0", commit: current.sha };

test.each([
  ["a reversible release", {}, null],
  ["a request for another release", { requested: "v2.0.0" }, "target is not the previous stable release"],
  ["a different deployed SHA", { health: { ...health, commit: previous.sha } }, "current deployment unverified"],
  ["a missing current receipt", { currentAsset: null }, "current receipt unavailable or invalid"],
  [
    "a current receipt naming another predecessor",
    { currentAsset: { ...currentAsset, previousVersion: "2.0.0" } },
    "current receipt names a different previous release",
  ],
  [
    "recorded migration changes even without a target receipt",
    { currentAsset: { ...currentAsset, migrations: [migration] }, previousAsset: null },
    "migrations",
  ],
  [
    "inconsistent migration histories",
    { currentAsset: { ...currentAsset, productionMigrationHistory: [migration] } },
    "migrations",
  ],
  [
    "a mismatched target SHA",
    { previousAsset: { ...previousAsset, sha: current.sha } },
    "target receipt unavailable or invalid",
  ],
  [
    "a runtime protocol bump",
    { currentAsset: { ...currentAsset, protocolBump: { ...currentAsset.protocolBump, runtime: { from: 1, to: 2 } } } },
    "protocol bump or missing protocol evidence",
  ],
  [
    "a missing target Docker host protocol",
    { previousAsset: { ...previousAsset, protocolBump: { runtime: previousAsset.protocolBump.runtime } } },
    "protocol bump or missing protocol evidence",
  ],
  [
    "a surface break",
    { currentAsset: { ...currentAsset, surfaceBreak: ["GET /removed"] } },
    "surface break or missing surface evidence",
  ],
] as [
  string,
  Partial<{ requested: string; health: unknown; currentAsset: unknown; previousAsset: unknown }>,
  string | null,
][])("classifies %s", (_name, overrides, expected) => {
  const inputs = { requested: previous.tag, health, currentAsset, previousAsset, ...overrides };
  expect(
    rollbackRefusal(inputs.requested, current, previous, inputs.health, inputs.currentAsset, inputs.previousAsset),
  ).toBe(expected);
});
