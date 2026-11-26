import { expect, test } from "bun:test";
import {
  LANGFUSE_HOST_CHANGE_ERROR,
  LANGFUSE_MISSING_FIELDS_ERROR,
  parseLangfuseSettings,
  readLangfuseForm,
} from "./langfuse";

test("member status strips admin details even if the upstream response contains them", () => {
  expect(
    parseLangfuseSettings(
      {
        enabled: true,
        contentMode: "full",
        host: "https://example.com",
        counters: { exported: 90, failed: 0, dropped: 0 },
      },
      false,
    ),
  ).toEqual({ scope: "member", enabled: true, contentMode: "full" });
});

test("a mode-only edit omits stored credentials and an equivalent host", () => {
  const form = new FormData();
  form.set("host", " https://cloud.langfuse.com/ ");
  form.set("publicKey", " fixture_public ");
  form.set("contentMode", "full");
  expect(
    readLangfuseForm(form, {
      host: "https://cloud.langfuse.com",
      publicKey: "fixture_public",
      contentMode: "metadata",
    }),
  ).toEqual({ ok: true, input: { contentMode: "full" } });
});

test("moving to a new host sends both keys required by the API", () => {
  const form = new FormData();
  form.set("host", "https://us.cloud.langfuse.com");
  form.set("publicKey", "fixture_public");
  form.set("secretKey", "fixture_replacement");
  form.set("contentMode", "metadata");
  expect(
    readLangfuseForm(form, {
      host: "https://cloud.langfuse.com",
      publicKey: "fixture_public",
      contentMode: "metadata",
    }),
  ).toEqual({
    ok: true,
    input: {
      host: "https://us.cloud.langfuse.com",
      publicKey: "fixture_public",
      secretKey: "fixture_replacement",
    },
  });
});

test("moving to a new host explains that replacing the Secret key is required", () => {
  const form = new FormData();
  form.set("host", "https://us.cloud.langfuse.com");
  form.set("publicKey", "fixture_public");
  form.set("contentMode", "metadata");
  const result = readLangfuseForm(form, {
    host: "https://cloud.langfuse.com",
    publicKey: "fixture_public",
    contentMode: "metadata",
  });
  expect(result).toEqual({ ok: false, error: LANGFUSE_HOST_CHANGE_ERROR });
  expect(result.ok === false && result.error).not.toBe(LANGFUSE_MISSING_FIELDS_ERROR);
  expect(result.ok === false && result.error.toLowerCase()).toContain("secret key");
});
