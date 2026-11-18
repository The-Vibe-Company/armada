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

test("an edit using the stored secret omits the key from the patch", () => {
  const form = new FormData();
  form.set("host", " https://cloud.langfuse.com ");
  form.set("publicKey", " fixture_public ");
  form.set("contentMode", "full");
  expect(readLangfuseForm(form)).toEqual({
    host: "https://cloud.langfuse.com",
    publicKey: "fixture_public",
    contentMode: "full",
  });
});
