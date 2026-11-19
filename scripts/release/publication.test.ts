import { expect, test } from "bun:test";
import { admissionTagSha, promotionRequired, publicationMode } from "./publication";

test("an unpublished version admits the selected candidate and an orphan tag fixes its SHA", () => {
  expect(publicationMode(404, "", "selected", false)).toBe("candidate");
  expect(publicationMode(404, "selected", "selected", true)).toBe("candidate");
  expect(() => publicationMode(404, "other", "selected", false)).toThrow();
});

test("main can prepare after publication while recovery must match the published SHA", () => {
  expect(publicationMode(200, "published", "later-main", false)).toBe("prepare");
  expect(publicationMode(200, "published", "published", true)).toBe("recover");
  expect(() => publicationMode(200, "published", "later-main", true)).toThrow();
  expect(() => publicationMode(200, "", "published", false)).toThrow();
});

test("admission resolves a newly published tag missing from its checkout", () => {
  let localTag = "";
  const readTag = () => localTag;
  const fetchTag = () => {
    localTag = "published";
  };

  expect(admissionTagSha(404, readTag, fetchTag)).toBe("");
  const tag = admissionTagSha(200, readTag, fetchTag);
  expect(tag).toBe("published");
  expect(publicationMode(200, tag, "later-main", false)).toBe("prepare");
});

test("GitHub or transport failure cannot authorize a candidate", () => {
  for (const status of [401, 503, Number.NaN]) {
    expect(() => publicationMode(status, "", "selected", false)).toThrow();
  }
});

test("promotion is idempotent and a published image cannot be replaced", () => {
  expect(promotionRequired(false, "", "smoked")).toBe(true);
  expect(promotionRequired(false, "smoked", "smoked")).toBe(false);
  expect(promotionRequired(true, "smoked", "smoked")).toBe(false);
  expect(() => promotionRequired(true, "other", "smoked")).toThrow();
});
