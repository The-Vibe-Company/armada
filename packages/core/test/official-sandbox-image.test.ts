import { expect, test } from "bun:test";
import { DOCKER_DEFAULT_IMAGE } from "../src/docker-api.ts";
import { officialSandboxImage, resolveDockerLaunchImage } from "../src/official-sandbox-image.ts";

test("source deployments resolve a server-owned immutable baseline and release pins remain authoritative", () => {
  expect(officialSandboxImage()).toBe(DOCKER_DEFAULT_IMAGE);
  expect(resolveDockerLaunchImage(null, "2.29.0")).toBe(DOCKER_DEFAULT_IMAGE);
  const image = `ghcr.io/the-vibe-company/armada-sandbox@sha256:${"a".repeat(64)}`;
  expect(resolveDockerLaunchImage({ version: "2.28.0", image }, "2.28.0")).toBe(image);
  for (const pin of [undefined, {}, { version: "2.27.0", image }, { version: "2.28.0", image: "custom:latest" }])
    expect(() => resolveDockerLaunchImage(pin, "2.28.0")).toThrow("invalid official sandbox image pin");
});
