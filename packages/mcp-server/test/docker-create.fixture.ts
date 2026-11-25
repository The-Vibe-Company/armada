import type { Sql } from "@armada/core";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { createDockerSandboxService } from "../src/docker-sandbox-service.ts";

export async function queueMailboxCreate(
  sql: Sql,
  key: string,
  actor: Parameters<ReturnType<typeof createDockerSandboxService>["reserve"]>[0],
  input: Parameters<ReturnType<typeof createDockerSandboxService>["reserve"]>[1],
) {
  const sandbox = await createDockerSandboxService(sql).reserve(actor, input);
  await createDockerHostStore(sql, key).enqueueSandbox(actor, sandbox.id, {
    requestId: sandbox.id,
    operation: "create",
  });
  return sandbox;
}
