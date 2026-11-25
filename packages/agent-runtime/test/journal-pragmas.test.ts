import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/journal.ts";

test("file-backed journal configures WAL mode with synchronous=NORMAL and truncates WAL on flush", () => {
  const dir = mkdtempSync(join(tmpdir(), "armada-journal-pragmas-"));
  const dbPath = join(dir, "journal.sqlite");
  let journal: Journal | undefined;
  let reopened: Journal | undefined;
  try {
    journal = new Journal(dbPath, (text) => text);
    expect(journal.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    const SQLITE_SYNCHRONOUS_NORMAL = 1;
    expect(journal.db.query("PRAGMA synchronous").get()).toEqual({ synchronous: SQLITE_SYNCHRONOUS_NORMAL });
    expect(journal.db.query("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });

    journal.append({ id: "delta-1", at: 1, kind: "other", type: "fixture", data: { text: "hello" } });
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

    journal.flush();
    expect(statSync(`${dbPath}-wal`).size).toBe(0);

    journal.close();
    journal = undefined;

    reopened = new Journal(dbPath, (text) => text);
    expect(reopened.events()).toMatchObject([{ sequence: 1, event: { id: "delta-1" } }]);
  } finally {
    reopened?.close();
    journal?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
