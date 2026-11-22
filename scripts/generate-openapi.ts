import { generateOpenApi } from "../packages/mcp-server/src/openapi.ts";

await Promise.all(
  (
    [
      ["openapi.json", "integration"],
      ["openapi-admin.json", "admin"],
    ] as const
  ).map(([file, projection]) =>
    Bun.write(
      new URL(`../packages/mcp-server/${file}`, import.meta.url),
      `${JSON.stringify(generateOpenApi({ projection }), null, 2)}\n`,
    ),
  ),
);
