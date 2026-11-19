import { expect, test } from "bun:test";
import { capabilities } from "@armada/core/server";

test("machine capabilities match the approved runtime provider matrix", () => {
  const catalogSizes = ["small", "medium", "large", "xlarge"] as const;
  expect({
    boat: capabilities("boat"),
    modal: capabilities("modal"),
    docker: capabilities("docker"),
  }).toEqual({
    boat: {
      maxTtlSeconds: 2_592_000,
      stopRetention: "disk",
      snapshots: "required",
      extendLifetime: true,
      humanSsh: true,
      resourceSampler: true,
      sizes: catalogSizes,
    },
    modal: {
      maxTtlSeconds: 86_400,
      stopRetention: "image",
      snapshots: "optional",
      extendLifetime: true,
      humanSsh: true,
      resourceSampler: true,
      sizes: catalogSizes,
    },
    docker: {
      maxTtlSeconds: 86_400,
      stopRetention: "container",
      snapshots: "optional",
      extendLifetime: false,
      humanSsh: false,
      resourceSampler: false,
      sizes: [],
    },
  });
});
