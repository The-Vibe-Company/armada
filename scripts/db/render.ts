import { fileURLToPath } from "node:url";
import { generateDatabaseTypes } from "./generate.ts";

const target = fileURLToPath(new URL("../../packages/core/src/database.types.ts", import.meta.url));
await Bun.write(target, await generateDatabaseTypes());
console.log("wrote packages/core/src/database.types.ts");
