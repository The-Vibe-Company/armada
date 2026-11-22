import type { Provider, Sql, VaultStore } from "@armada/core";
import { type Scope, scopeKey } from "@armada/provider-modal";
import { admitModalLaunch } from "../src/jobs/modal-launch.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createModalLaunchAdmission } from "../src/modal-launch-admission.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeMcp } from "../src/runtime-mcp.ts";

export async function modalAdmissionFixture(sql: Sql, key: string, vault: VaultStore, scope: Scope, host: Provider) {
  const scopeId = scopeKey(scope);
  await sql.query(
    `insert into modal_machines(scope,org_id,owner_id,visibility,id,request_key,record)
     values($1,$2,$3,$4,'builder','builder','{}')`,
    [scopeId, scope.orgId, scope.userId, scope.visibility],
  );
  await sql.query(
    `insert into modal_images(scope,name,source_id,record)
     values($1,'image','builder','{"info":{"status":"ready"},"imageId":"im-snapshot"}')`,
    [scopeId],
  );
  const commands = createRuntimeCommands(createRuntimeEnrolments(sql, key), key);
  const mcp = createRuntimeMcp({ sql, key, commands, origin: "https://armada.test" });
  return createModalLaunchAdmission(
    sql,
    {
      policy: {
        async start() {
          throw Error("Request must not bootstrap compute");
        },
      },
      credentials: launchCredentials(vault, key),
      connections: mcp.connections,
      provider: async () => host,
    },
    {},
    (input) => admitModalLaunch(sql, key, input, mcp),
  );
}
