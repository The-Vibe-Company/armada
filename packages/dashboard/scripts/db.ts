// The app's database from a terminal (ARMADA_DATABASE_URL, or DATABASE_URL):
//   bun run db migrate                      bring the schema up to date (the app also does it on first use)
//   bun run db register <path/armada.toml>  register a project, as `armada init` does
// A project registered without an organization joins the deployment's first
// organization on the dashboard's next read. Until the CLI registers projects
// through the app (THE-850), `register` is how a project gets on a new database.
import { readFile } from "node:fs/promises";
import { parseConfig } from "@armada/core/read";
import { DATABASE_VARIABLE, databaseUrlOf, openDatabase, redactDatabase } from "../lib/db";
import { upsertProject } from "../lib/fleet-store";

async function main(): Promise<number> {
  const [command, path] = process.argv.slice(2);
  if (command !== "migrate" && command !== "register") {
    console.error("usage: bun run db migrate | bun run db register <path/to/armada.toml>");
    return 2;
  }
  const url = databaseUrlOf(process.env);
  if (!url) {
    console.error(`${DATABASE_VARIABLE} is not set (a postgres:// URL, or pglite:<directory> locally)`);
    return 2;
  }
  // Opening applies the migrations.
  const db = await openDatabase(url);
  try {
    if (command === "migrate") {
      console.log("The app's database schema is up to date.");
      return 0;
    }
    if (!path) {
      console.error("usage: bun run db register <path/to/armada.toml>");
      return 2;
    }
    const config = parseConfig(await readFile(path, "utf8"), path);
    await upsertProject(db, {
      slug: config.project.slug,
      name: config.project.name,
      repository: config.github.repository,
      programRoot: config.tracker.programRoot,
    });
    console.log(`Registered project ${config.project.slug} (${config.github.repository}).`);
    return 0;
  } finally {
    await db.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`armada db: ${redactDatabase(err, databaseUrlOf(process.env))}`);
    process.exit(1);
  },
);
