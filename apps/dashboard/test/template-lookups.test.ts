import { expect, test } from "bun:test";
import type { Golden } from "@armada/core";
import { lookupsFrom } from "../src/lib/data/templates.ts";

test("a golden on a provider goldens do not support is left out of the template lookups, not a failed page", () => {
  const golden = (id: string, provider: string) =>
    ({ id, name: id, provider, visibility: "org", provider_snapshot_id: null }) as unknown as Golden;
  const lookups = lookupsFrom(
    [golden("g-boat", "boat"), golden("g-docker", "docker")],
    { state: "not-configured" },
    { state: "not-configured" },
  );
  expect(lookups.goldens.map((item) => item.id)).toEqual(["g-boat"]);
});
