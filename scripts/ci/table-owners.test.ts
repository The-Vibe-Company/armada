import { expect, test } from "bun:test";
import { checkTableOwners } from "./table-owners";

const writer = "packages/mcp-server/src/unrelated.ts";
const sandboxOwner = "packages/mcp-server/src/sandbox-lifecycle.ts";
const sandboxUpdate = "UPDATE public.sandboxes SET status = 'running'";
const exception = `${writer}\tsandboxes\tupdate`;

test.each([
  ["insert", 'INSERT INTO ONLY "public"."sandboxes" (id) VALUES (1)', 1],
  ["update", sandboxUpdate, 1],
  ["delete", "DELETE\nFROM sandboxes WHERE id = 1", 1],
  ["insert", "supabase.from('sandboxes').insert({})", 1],
  ["update", 'supabase\n.from("sandboxes")\n.update({})', 2],
  ["upsert", 'supabase.from("sandboxes").upsert({})', 1],
  ["delete", 'supabase.from("sandboxes").delete()', 1],
])("reports a cross-module %s with its file, table and owner", (verb, source, line) => {
  const errors = checkTableOwners([[writer, source]], []);
  expect(errors).toEqual([expect.stringContaining(`${writer}:${line}: ${verb} on sandboxes belongs to`)]);
  expect(errors[0]).toContain(sandboxOwner);
});

test("permits owner writes and ignores reads and other schemas", () => {
  const reads = `SELECT * FROM public.sandboxes FOR UPDATE;
    UPDATE local.sandboxes SET status = 'running';
    supabase.from("sandboxes").select("status");`;
  expect(
    checkTableOwners(
      [
        [sandboxOwner, sandboxUpdate],
        [writer, reads],
      ],
      [],
    ),
  ).toEqual([]);
});

test("an exception covers one write and becomes stale when that write goes away", () => {
  expect(checkTableOwners([[writer, sandboxUpdate]], [exception])).toEqual([]);
  expect(checkTableOwners([[writer, `${sandboxUpdate}\n${sandboxUpdate}`]], [exception])).toEqual([
    expect.stringContaining(`${writer}:2: update on sandboxes`),
  ]);
  expect(checkTableOwners([[writer, ""]], [exception])).toEqual([
    expect.stringContaining(`stale exception(s) from scripts/ci/table-owners-allowlist.txt: ${exception}`),
  ]);
});

test("rejects new exceptions even when they correspond to real writes", () => {
  expect(checkTableOwners([[writer, sandboxUpdate]], [exception], [])).toEqual([`Allowlist grew: ${exception}`]);
  expect(checkTableOwners([], [], [exception])).toEqual([]);
});
