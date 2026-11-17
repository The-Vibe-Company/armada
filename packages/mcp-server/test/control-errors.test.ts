import { expect, test } from "bun:test";
import { LaunchError } from "@armada/core";
import { controlFailureResponse } from "../src/control-errors.ts";
import { DockerHostDraining, DockerHostFull } from "../src/docker-capacity.ts";

test("Docker capacity refusal is a host_full HTTP conflict with actionable guidance", async () => {
  const response = controlFailureResponse(new DockerHostFull("build-host", 2, 2));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: {
      code: "host_full",
      message:
        "The selected host has no free sandbox slots. Stop a sandbox or ask its administrator to raise the limit, then retry.",
    },
  });
});

test("a draining host is a host_draining conflict with the uninstall guidance, not a permission failure", async () => {
  const response = controlFailureResponse(new DockerHostDraining());
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: {
      code: "host_draining",
      message:
        "This host is draining for uninstall. Finish or retry the uninstall on the machine; it takes new work again only after the uninstall completes.",
    },
  });
});

test("post-start launch failures retain their cause as upstream failures", async () => {
  for (const code of ["start_failed", "init_failed", "prompt_failed"] as const) {
    const response = controlFailureResponse(new LaunchError(code, "private_diagnostic"));
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(code);
    expect(body.error.message).not.toContain("private_diagnostic");
  }
});
