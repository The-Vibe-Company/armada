import { expect, test } from "bun:test";
import { countArchitecture } from "./architecture-counters";

test("counts architecture signals across a fixture tree with production and migration paths", () => {
  const files = new Map([
    [
      "packages/mcp-server/src/run.ts",
      [
        'const path = agentPath ?? "native";',
        "if (provider === 'boat' || provider === \"modal\") launch();",
        "sql(`update public.sandboxes s set status='ready', lease_until=now() where id=$1`);",
        "sql(`update sandboxes set lease_until=null where status='running'`);",
      ].join("\n"),
    ],
    ["packages/provider-boat/src/run.ts", "if (provider === 'boat') launch();\n"],
    ["packages/agent-runtime/src/run.ts", 'const path = "native";\n'],
    ["packages/docker-host/src/run.ts", "if (provider === 'docker') launch();\n"],
    ["packages/core/src/runtime.test.ts", 'const path = "native";\n'],
    ["packages/core/src/database.types.ts", 'type Path = "native";\n'],
    ["apps/dashboard/src/read.ts", 'sql("update sandboxes set note=$1 where status=$2");\n'],
    ["supabase/migrations/001.sql", "update sandboxes set note='done', status='ready', lease_until=now();\n"],
    ["supabase/migrations/002.sql", "update task_jobs set lease_until=$1 where id=$2;\n"],
    ["supabase/migrations/003.sql", "update archived_jobs set lease_until=null where id=$1;\n"],
  ]);

  expect(countArchitecture(files)).toEqual({
    nativeReferences: 2,
    nativeReferenceFiles: 1,
    nonTestSourceLines: 8,
    providerIdBranchesOutsideAdapters: 2,
    sandboxStatusWriterFiles: 2,
    bespokeLeaseClaimImplementations: 2,
    leaseClaimTables: ["sandboxes", "task_jobs"],
    netSourceLines: 8,
  });
});
