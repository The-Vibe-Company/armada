import { expect, test } from "bun:test";
import { controlFailureResponse } from "../src/control-errors.ts";
import { DockerHostFull } from "../src/docker-capacity.ts";

test("Docker capacity refusal is a host_full HTTP conflict with actionable guidance", async () => {
  const response = controlFailureResponse(new DockerHostFull("build-host", 2, 2));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: {
      code: "host_full",
      message: "Host build-host is full: 2/2 sandboxes running; stop one or raise the limit.",
    },
  });
});
