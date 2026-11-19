import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { migrationsDir } from "../../../../scripts/db/apply.ts";

export async function applyPostgresFixtureMigrations(client: Bun.SQL, prerequisites: string) {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const connection = await client.reserve();
  try {
    await connection.unsafe(prerequisites);
    for (const file of files) {
      await connection.unsafe(await Bun.file(join(migrationsDir, file)).text());
    }
  } finally {
    connection.release();
  }
}
