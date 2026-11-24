import { expect, test } from "bun:test";
import type { Sql } from "@armada/core";
import { createBoatResumePolicy } from "./boat-runtime-resume.ts";
import { createDockerBootstrapService } from "./docker-bootstrap-service.ts";
import { createModalResumePolicy } from "./modal-runtime-resume.ts";

test("unpublished runtime architecture is rejected before any provider or database allocation", () => {
  const options = {
    architecture: "arm64" as const,
    serverUrl: "https://armada.example",
    manifest: {},
    sql: {} as Sql,
    encryptionKey: "",
  };
  const message = "Runtime artifacts are not published for architecture: arm64";
  expect(() => createBoatResumePolicy(options)).toThrow(message);
  expect(() => createModalResumePolicy(options)).toThrow(message);
  expect(() =>
    createDockerBootstrapService(options.sql, "", {
      ...options,
      credentials: {} as Parameters<typeof createDockerBootstrapService>[2]["credentials"],
    }),
  ).toThrow(message);
});
