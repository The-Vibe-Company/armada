import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completeCredentialRepoint,
  prepareCredentialRepoint,
  scrubRepointCredentialFiles,
} from "../src/credential-repoint.ts";
import { Journal } from "../src/journal.ts";

test("a new binding registers old auth before restore and never mistakes incomplete hydration for a surviving native session", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-repoint-"));
  let journal: Journal | undefined;
  try {
    await mkdir(join(root, "codex"));
    await mkdir(join(root, "claude"));
    const old = "opaque-older-retained-api-secret",
      fresh = "new-native-access-secret";
    await writeFile(join(root, "codex/auth.json"), JSON.stringify({ OPENAI_API_KEY: old }), { mode: 0o600 });
    journal = new Journal(join(root, "journal.sqlite"), (text) => text);
    journal.append({
      id: "retained",
      at: 1,
      kind: "message",
      role: "assistant",
      text: `old transcript ${old}`,
      partial: false,
    });
    expect(JSON.stringify(journal.db.query("select body from events").all())).toContain(old);
    expect(
      await prepareCredentialRepoint(
        root,
        "new-operation",
        (values) => journal!.registerSecrets(values),
        () => journal!.sanitize(),
      ),
    ).toBe(true);
    await expect(readFile(join(root, "codex/auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const rows = journal.db.query("select body from events").all();
    expect(JSON.stringify(rows)).not.toContain(old);
    // A previous archive must not be able to restore an old auth file after this phase.
    await writeFile(join(root, "codex/auth.json"), JSON.stringify({ OPENAI_API_KEY: old }));
    await scrubRepointCredentialFiles(root);
    await expect(readFile(join(root, "codex/auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(
      join(root, "codex/auth.json"),
      JSON.stringify({
        tokens: { access_token: fresh, refresh_token: "new-native-refresh", account_id: "same-account" },
      }),
    );
    // Failed boot, before completion/listener admission: retry may safely replace its never-used file.
    expect(
      await prepareCredentialRepoint(
        root,
        "new-operation",
        (values) => journal!.registerSecrets(values),
        () => journal!.sanitize(),
      ),
    ).toBe(true);
    await writeFile(join(root, "codex/auth.json"), fresh);
    await completeCredentialRepoint(root, "new-operation");
    expect(
      await prepareCredentialRepoint(
        root,
        "new-operation",
        () => {
          throw Error("must not replace a completed current native home");
        },
        () => {},
      ),
    ).toBe(false);
    expect(await readFile(join(root, "codex/auth.json"), "utf8")).toBe(fresh);
    expect(
      await prepareCredentialRepoint(
        root,
        undefined,
        () => {},
        () => {},
      ),
    ).toBe(false);
  } finally {
    journal?.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
