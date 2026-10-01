import { afterAll, beforeAll, expect, test } from "bun:test";
import { CONFIG_DEFAULTS, parseConfig } from "@armada/core/read";
import { NextRequest } from "next/server";
import { DEMO_TOML } from "../../core/test/support.ts";
import { accountsGuard } from "../lib/accounts-http.ts";
import { attachmentBody, attachmentInput } from "../lib/attachment-http.ts";
import {
  listTicketAttachments,
  pruneAttachments,
  readAttachment,
  saveAttachment,
  serveAttachment,
} from "../lib/attachments.ts";
import type { Database } from "../lib/db.ts";
import { assignUnownedProjects, upsertProject } from "../lib/fleet-store.ts";
import { addOrganizations, scalar, tempDatabase } from "./support.ts";

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
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  expect((await serveAttachment(db, null, image.id)).status).toBe(403);
  const other = { organization: "org-b", home: "org-a" };
  expect((await serveAttachment(db, other, image.id)).status).toBe(403);
  expect(await readAttachment(db, other, image.id)).toBeNull();
  expect(await listTicketAttachments(db, other, "widgets", "DEMO-7")).toBeNull();
  const redirect = await serveAttachment(db, scope, link.id);
  expect(redirect.status).toBe(303);
  expect(redirect.headers.get("location")).toBe("https://example.test/design");
  const anonymous = await accountsGuard(new NextRequest(`https://example.test/api/attachments/${image.id}`), {
    env: {},
    session: async () => "none",
  });
  expect(anonymous.status).toBe(403);
});

test("duplicates store bytes once, can bind a new free reference, and do not consume quota", async () => {
  const input = { kind: "image" as const, bytes: png, contentType: "image/png" };
  const first = await saveAttachment(db, { ...target("DEMO-8"), input });
  const second = await saveAttachment(db, {
    ...target("DEMO-8"),
    input,
    policy: { ...policy, attachmentsPerTicket: 1 },
    reference: "owner-check",
  });
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
