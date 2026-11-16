import { expect, test } from "bun:test";
import { generateDatabaseTypes } from "../../../scripts/db/generate.ts";

test("generated types match the migrations", async () => {
  const generated = await generateDatabaseTypes();
  const committed = await Bun.file(new URL("../src/database.types.ts", import.meta.url)).text();
  expect(committed).toBe(generated);
});
