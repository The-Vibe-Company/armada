import { expect, test } from "bun:test";
import { DOCKER_HOST_LABEL, dockerHostGroup } from "./labels.ts";

test("a Docker host group carries the shared term that the picker displays and searches", () => {
  expect(dockerHostGroup("Large platform", "online")).toBe(`Large platform · ${DOCKER_HOST_LABEL} · online`);
  expect(dockerHostGroup(null, "offline")).toBe(`${DOCKER_HOST_LABEL} · offline`);
});
