import { expect, test } from "bun:test";
import { parseLangfuseSettings, readLangfuseForm } from "./langfuse";

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

test("a mode-only edit omits the stored credentials and untouched host", () => {
  const form = new FormData();
  form.set("host", " https://cloud.langfuse.com ");
  form.set("publicKey", " fixture_public ");
  form.set("contentMode", "full");
  expect(
    readLangfuseForm(form, {
      host: "https://cloud.langfuse.com",
      publicKey: "fixture_public",
      contentMode: "metadata",
    }),
  ).toEqual({ contentMode: "full" });
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
    host: "https://us.cloud.langfuse.com",
    publicKey: "fixture_public",
    secretKey: "fixture_replacement",
  });
});
