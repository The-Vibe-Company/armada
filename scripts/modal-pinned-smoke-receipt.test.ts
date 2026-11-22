import { expect, test } from "bun:test";
import { parseExplicitPinnedAdmission } from "./modal-pinned-smoke-receipt.ts";

const sandbox = { id: "4ddc67d3-db73-4d3b-8c46-e84b4aa13d59", status: "starting" };
const templateManifest = { revision: 2, resolvedSkills: [] };

test("explicit pinned smoke reads a prompt-free starting receipt and its frozen manifest", () => {
  expect(parseExplicitPinnedAdmission({ sandbox: { ...sandbox, templateManifest } })).toEqual({
    sandbox,
    templateManifest,
  });
});

test("explicit pinned smoke rejects a starting receipt that also returns a prompt ID", () => {
  const reply = { sandbox: { ...sandbox, templateManifest }, promptId: "unexpected" };
  expect(() => parseExplicitPinnedAdmission(reply)).toThrow("Invalid explicit pinned Modal starting receipt.");
});
