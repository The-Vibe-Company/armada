import { generateOpenApi } from "../packages/mcp-server/src/openapi.ts";

await Bun.write(
  new URL("../packages/mcp-server/openapi.json", import.meta.url),
  `${JSON.stringify(await generateOpenApi(), null, 2)}\n`,
);
