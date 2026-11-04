import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CONFIG_DEFAULTS, parseConfig } from "@armada/core/read";
import { NextRequest } from "next/server";
import { DEMO_TOML } from "../../core/test/support.ts";
import { accountsGuard } from "../lib/accounts-http.ts";
import { attachmentBody, attachmentInput } from "../lib/attachment-http.ts";
import {
  listTicketAttachments,
  pruneAttachments as prune,
  readAttachment,
  saveAttachment as save,
  serveAttachment as serve,
} from "../lib/attachments.ts";
import type { Database, Queryable } from "../lib/db.ts";
import { assignUnownedProjects, upsertProject } from "../lib/fleet-store.ts";
import { fakeAttachmentBlobs } from "./attachment-support.ts";
import { addOrganizations, scalar, tempDatabase } from "./support.ts";

const blobs = fakeAttachmentBlobs();
const saveAttachment = (...[db, target]: Parameters<typeof save>) => save(db, target, blobs);
const serveAttachment = (...[db, scope, id, etag]: Parameters<typeof serve>) => serve(db, scope, id, etag, blobs);
const pruneAttachments = (...[db, project, issues, days, now]: Parameters<typeof prune>) =>
  prune(db, project, issues, days, now, blobs);
let db: Database;
const now = new Date("2026-04-01T00:00:00Z");
const policy = parseConfig(DEMO_TOML).policy;
const scope = { organization: "org-a", home: "org-a" };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const target = (ticket: string) => ({
  project: "widgets",
  ticket,
  author: "Demo Worker",
  caption: "Overview",
  reference: null,
  now,
  policy,
});
beforeAll(async () => {
  db = await tempDatabase();
  await addOrganizations(db, "org-a", "org-b");
  await upsertProject(db, { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "DEMO-1" }, now);
  await assignUnownedProjects(db, "org-a", now);
});
afterAll(() => db.end());

test("an image and link are private metadata with member-only bytes", async () => {
  const image = await saveAttachment(db, {
    ...target("DEMO-7"),
    input: { kind: "image", bytes: png, contentType: "image/png" },
  });
  const row = (
    await db.query("SELECT bytes, storage_key, stored_at, size, content_type FROM attachments WHERE id = $1", [
      image.id,
    ])
  ).rows[0];
  expect(row?.bytes).toBeNull();
  expect(row?.storage_key).toBe(`attachments/widgets/${createHash("sha256").update(png).digest("hex")}`);
  expect(new Date(String(row?.stored_at)).toISOString()).toBe(now.toISOString());
  expect(row?.size).toBe(png.length);
  expect(row?.content_type).toBe("image/png");
  expect(blobs.put).toHaveBeenLastCalledWith(row?.storage_key, png, "image/png");
  const link = await saveAttachment(db, {
    ...target("DEMO-7"),
    input: { kind: "link", url: "https://example.test/design" },
    reference: "validation-1",
  });
  const list = await listTicketAttachments(db, scope, "widgets", "DEMO-7");
  expect(list).toHaveLength(2);
  expect(list?.every((item) => !("bytes" in item))).toBe(true);
  expect(link.reference).toBe("validation-1");
  const response = await serveAttachment(db, scope, image.id);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  expect(response.headers.get("etag")).toBe(`"${image.sha256}"`);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("content-disposition")).toBe('inline; filename="attachment"');
  expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  const reads = blobs.get.mock.calls.length;
  const anonymousImage = await serveAttachment(db, null, image.id, `"${image.sha256}"`);
  expect(anonymousImage.status).toBe(403);
  expect(anonymousImage.headers.get("cache-control")).toBe("private, no-store");
  const other = { organization: "org-b", home: "org-a" };
  const forbidden = await serveAttachment(db, other, image.id, `"${image.sha256}"`);
  expect(forbidden.status).toBe(403);
  expect(forbidden.headers.get("cache-control")).toBe("private, no-store");
  expect(forbidden.headers.get("etag")).toBeNull();
  expect(blobs.get.mock.calls.length).toBe(reads);
  expect(await readAttachment(db, other, image.id)).toBeNull();
  expect(await listTicketAttachments(db, other, "widgets", "DEMO-7")).toBeNull();
  const redirect = await serveAttachment(db, scope, link.id, "*");
  expect(redirect.headers.get("cache-control")).toBe("private, no-store");
  expect(redirect.status).toBe(303);
  expect(redirect.headers.get("location")).toBe("https://example.test/design");
  const anonymous = await accountsGuard(new NextRequest(`https://example.test/api/attachments/${image.id}`), {
    env: {},
    session: async () => "none",
  });
  expect(anonymous.status).toBe(403);
});

test("image revalidation reads metadata only and returns bytes only on a cache miss", async () => {
  const image = await saveAttachment(db, {
    ...target("DEMO-13"),
    input: { kind: "image", bytes: png, contentType: "image/png" },
  });
  const etag = `"${image.sha256}"`;
  const metadataOnly: Queryable = {
    async query<R>(sql: string, params?: readonly unknown[]) {
      const result = await db.query<R>(sql, params);
      // Check the real database result: selecting the blob (including SELECT *) fails this contract.
      expect(result.rows.every((row) => !("bytes" in (row as object)))).toBe(true);
      return result;
    },
  };
  const reads = blobs.get.mock.calls.length;
  for (const validator of [etag, `W/${etag}`, `"other", W/${etag}`, "*"]) {
    const response = await serveAttachment(metadataOnly, scope, image.id, validator);
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(response.body).toBeNull();
  }
  expect(blobs.get.mock.calls.length).toBe(reads);
  const missing = await serveAttachment(metadataOnly, scope, "missing-attachment", "*");
  expect(missing.status).toBe(403);
  expect(missing.headers.get("cache-control")).toBe("private, no-store");
  const miss = await serveAttachment(db, scope, image.id, '"other"');
  expect(miss.status).toBe(200);
  expect(Buffer.from(await miss.arrayBuffer())).toEqual(png);
});

test("duplicates upload once, can bind a new free reference, and do not consume quota", async () => {
  const input = { kind: "image" as const, bytes: png, contentType: "image/png" };
  const first = await saveAttachment(db, { ...target("DEMO-8"), input });
  const uploads = blobs.put.mock.calls.length;
  const second = await saveAttachment(db, {
    ...target("DEMO-8"),
    input,
    policy: { ...policy, attachmentsPerTicket: 1 },
    reference: "owner-check",
  });
  expect(blobs.put.mock.calls.length).toBe(uploads);
  expect(second.id).toBe(first.id);
  expect(second.reference).toBe("owner-check");
  expect(await scalar(db, "SELECT count(*) FROM attachments WHERE ticket = 'DEMO-8'")).toBe(1);
  await expect(
    saveAttachment(db, {
      ...target("DEMO-8"),
      input: { kind: "link", url: "https://example.test/new" },
      policy: { ...policy, attachmentsPerTicket: 1 },
    }),
  ).rejects.toThrow("count limit: 1");
});

test("size, actual type and project byte quotas are enforced", async () => {
  await expect(
    saveAttachment(db, {
      ...target("DEMO-9"),
      input: { kind: "image", bytes: new Uint8Array(2 * 1024 * 1024 + 1), contentType: "image/png" },
    }),
  ).rejects.toThrow("2 MB");
  await expect(
    saveAttachment(db, { ...target("DEMO-9"), input: { kind: "image", bytes: png, contentType: "image/jpeg" } }),
  ).rejects.toThrow("type limit");
  const large = Buffer.alloc(1024 * 1024);
  png.copy(large);
  await expect(
    saveAttachment(db, {
      ...target("DEMO-9"),
      input: { kind: "image", bytes: large, contentType: "image/png" },
      policy: { ...policy, attachmentsProjectMb: 1 },
    }),
  ).rejects.toThrow("project size limit: 1 MB");
});

test("transactional ticket quotas hold for concurrent uploads", async () => {
  const results = await Promise.allSettled(
    ["one", "two"].map((path) =>
      saveAttachment(db, {
        ...target("DEMO-10"),
        input: { kind: "link", url: `https://example.test/${path}` },
        policy: { ...policy, attachmentsPerTicket: 1 },
      }),
    ),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await scalar(db, "SELECT count(*) FROM attachments WHERE ticket = 'DEMO-10'")).toBe(1);
});

test("retention starts at completion, keeps active tickets, and resets on reopening", async () => {
  const input = { kind: "link" as const, url: "https://example.test/retention" };
  await saveAttachment(db, { ...target("DEMO-11"), input });
  const issues = [
    { id: "DEMO-11", statusType: "completed" as const, completedAt: now.toISOString(), canceledAt: null },
  ];
  expect(
    await pruneAttachments(
      db,
      "widgets",
      issues,
      CONFIG_DEFAULTS.attachmentsRetentionDays,
      new Date("2026-04-30T23:59:59Z"),
    ),
  ).toBe(0);
  expect(await pruneAttachments(db, "widgets", issues, 30, new Date("2026-05-01T00:00:00Z"))).toBe(1);
  expect(await scalar(db, "SELECT count(*) FROM attachments WHERE ticket = 'DEMO-7'")).toBe(2);
  await saveAttachment(db, { ...target("DEMO-12"), input, doneAt: now.toISOString() });
  expect(
    await pruneAttachments(
      db,
      "widgets",
      [{ id: "DEMO-12", statusType: "started", completedAt: null, canceledAt: null }],
      30,
      new Date("2026-05-02T00:00:00Z"),
    ),
  ).toBe(0);
});

test("the upload body is bounded and malformed images are rejected before storage", async () => {
  await expect(
    attachmentBody(new Request("https://example.test", { method: "POST", body: "x".repeat(3 * 1024 * 1024 + 1) })),
  ).rejects.toThrow("2 MB");
  expect(() => attachmentInput({ kind: "image", contentType: "image/png", data: "not base64!" })).toThrow("base64");
});

test("legacy images still serve from bytea and revalidate without loading bytes", async () => {
  const id = "legacy-image";
  const hash = createHash("sha256").update(png).digest("hex");
  await db.query(
    `INSERT INTO attachments (id, project, ticket, kind, bytes, content_type, size, sha256, author, created_at)
     VALUES ($1, 'widgets', 'DEMO-14', 'image', $2, 'image/png', $3, $4, 'Worker', $5)`,
    [id, png, png.length, hash, now],
  );
  const reads = blobs.get.mock.calls.length;
  const metadataOnly: Queryable = {
    async query<R>(sql: string, params?: readonly unknown[]) {
      const result = await db.query<R>(sql, params);
      expect(result.rows.every((row) => !("bytes" in (row as object)))).toBe(true);
      return result;
    },
  };
  expect((await serveAttachment(metadataOnly, scope, id, `"${hash}"`)).status).toBe(304);
  const response = await serveAttachment(db, scope, id);
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  expect(blobs.get.mock.calls.length).toBe(reads);
});

test("a failed insert rolls back and cleans only an unreferenced blob, even when deletion fails", async () => {
  for (const shared of [false, true]) {
    const bytes = Buffer.concat([png, Buffer.from(shared ? "shared" : "orphan")]);
    const input = { kind: "image" as const, bytes, contentType: "image/png" };
    const key = `attachments/widgets/${createHash("sha256").update(bytes).digest("hex")}`;
    if (shared) await saveAttachment(db, { ...target("DEMO-15"), input });
    const deletes = blobs.del.mock.calls.length;
    // A real database error after upload: created_at is NOT NULL.
    await expect(saveAttachment(db, { ...target("DEMO-16"), input, now: null as unknown as Date })).rejects.toThrow();
    expect(await scalar(db, "SELECT count(*) FROM attachments WHERE ticket = 'DEMO-16'")).toBe(0);
    expect(blobs.del.mock.calls.length).toBe(deletes + (shared ? 0 : 1));
    expect(blobs.objects.has(key)).toBe(shared);
  }
  const broken = fakeAttachmentBlobs();
  broken.del.mockRejectedValue(new Error("storage unavailable"));
  await expect(
    save(
      db,
      {
        ...target("DEMO-17"),
        input: { kind: "image", bytes: Buffer.concat([png, Buffer.from("cleanup-failure")]), contentType: "image/png" },
        now: null as unknown as Date,
      },
      broken,
    ),
  ).rejects.toThrow("null");
  expect(broken.del).toHaveBeenCalledTimes(1);
});

test("an upload whose acknowledgement fails still cleans an unreferenced Blob", async () => {
  const ambiguous = fakeAttachmentBlobs();
  ambiguous.put.mockImplementation(async (key, bytes) => {
    ambiguous.objects.set(key, new Uint8Array(bytes));
    throw new Error("upload acknowledgement lost");
  });
  await expect(
    save(
      db,
      {
        ...target("DEMO-20"),
        input: { kind: "image", bytes: Buffer.concat([png, Buffer.from("ambiguous")]), contentType: "image/png" },
      },
      ambiguous,
    ),
  ).rejects.toThrow("upload acknowledgement lost");
  expect(await scalar(db, "SELECT count(*) FROM attachments WHERE ticket = 'DEMO-20'")).toBe(0);
  expect(ambiguous.del).toHaveBeenCalledTimes(1);
  expect(ambiguous.objects.size).toBe(0);
});

test("pruning commits row deletion, retains shared content, and tolerates Blob deletion failure", async () => {
  const isolated = fakeAttachmentBlobs();
  const bytes = Buffer.concat([png, Buffer.from("retention")]);
  const input = { kind: "image" as const, bytes, contentType: "image/png" };
  const first = await save(db, { ...target("DEMO-18"), input, doneAt: now.toISOString() }, isolated);
  const second = await save(db, { ...target("DEMO-19"), input }, isolated);
  const key = `attachments/widgets/${first.sha256}`;
  const later = new Date("2026-05-02T00:00:00Z");
  expect(await prune(db, "widgets", [], 30, later, isolated)).toBe(1);
  expect(isolated.del).not.toHaveBeenCalled();
  expect(Buffer.from(await (await serve(db, scope, second.id, null, isolated)).arrayBuffer())).toEqual(bytes);
  let remainingAtDelete: number | undefined;
  isolated.del.mockImplementation(async (key) => {
    remainingAtDelete = await scalar(db, "SELECT count(*) FROM attachments WHERE id = $1", [second.id]);
    throw new Error(`cannot delete ${key}`);
  });
  expect(
    await prune(
      db,
      "widgets",
      [{ id: "DEMO-19", statusType: "completed", completedAt: now.toISOString(), canceledAt: null }],
      30,
      later,
      isolated,
    ),
  ).toBe(1);
  expect(remainingAtDelete).toBe(0);
  expect(isolated.del).toHaveBeenCalledWith(key);
  expect(await readAttachment(db, scope, second.id)).toBeNull();
});

test("mixed legacy and Blob copies leave no orphan after both tickets expire", async () => {
  const isolated = fakeAttachmentBlobs();
  const bytes = Buffer.concat([png, Buffer.from("mixed-retention")]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  await db.query(
    `INSERT INTO attachments (id, project, ticket, kind, bytes, content_type, size, sha256, author, created_at)
     VALUES ('mixed-legacy', 'widgets', 'DEMO-21', 'image', $1, 'image/png', $2, $3, 'Worker', $4)`,
    [bytes, bytes.length, hash, now],
  );
  await save(
    db,
    {
      ...target("DEMO-22"),
      input: { kind: "image", bytes, contentType: "image/png" },
      doneAt: now.toISOString(),
    },
    isolated,
  );
  expect(isolated.objects.size).toBe(1);
  const later = new Date("2026-05-02T00:00:00Z");
  expect(await prune(db, "widgets", [], 30, later, isolated)).toBe(1);
  const legacy = await serve(db, scope, "mixed-legacy", null, isolated);
  expect(legacy.status).toBe(200);
  expect(Buffer.from(await legacy.arrayBuffer())).toEqual(bytes);
  expect(
    await prune(
      db,
      "widgets",
      [{ id: "DEMO-21", statusType: "completed", completedAt: now.toISOString(), canceledAt: null }],
      30,
      later,
      isolated,
    ),
  ).toBe(1);
  expect(await readAttachment(db, scope, "mixed-legacy")).toBeNull();
  expect(isolated.objects.size).toBe(0);
});
