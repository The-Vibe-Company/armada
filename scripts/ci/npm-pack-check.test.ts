import { expect, test } from "bun:test";
import { checkBootstrappedPackages, checkPackFiles } from "./npm-pack-check.ts";

test("reports both missing and extra pack files", () => {
  expect(() => checkPackFiles("example-sdk", ["index.js", "debug.js"], ["index.js", "index.d.ts"])).toThrow(
    "example-sdk: npm pack file mismatch (missing: index.d.ts; extra: debug.js)",
  );
});

test("requires owner bootstrap for a staged package absent from the approval list", () => {
  expect(() => checkBootstrappedPackages([{ name: "example" }, { name: "example-new-target" }], ["example"])).toThrow(
    "owner bootstrap required: example-new-target",
  );
});
