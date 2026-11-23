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
      launchSource: "golden",
      maxTtlSeconds: 2_592_000,
      stopRetention: "disk",
      snapshots: "required",
      extendLifetime: true,
      humanSsh: true,
      resourceSampler: true,
      sizeResources: "instance-type",
      idleStop: true,
      resumeAfterStop: true,
      sizes: catalogSizes,
    },
    modal: {
      launchSource: "golden",
      maxTtlSeconds: 86_400,
      stopRetention: "image",
      snapshots: "optional",
      extendLifetime: true,
      humanSsh: true,
      resourceSampler: true,
      sizeResources: "explicit-limits",
      idleStop: true,
      resumeAfterStop: true,
      sizes: catalogSizes,
    },
    docker: {
      launchSource: "host",
      maxTtlSeconds: 86_400,
      stopRetention: "container",
      snapshots: "optional",
      extendLifetime: false,
      humanSsh: false,
      resourceSampler: false,
      sizeResources: "none",
      idleStop: false,
      resumeAfterStop: false,
      sizes: [],
    },
  });
});
