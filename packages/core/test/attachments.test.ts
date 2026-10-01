import { expect, test } from "bun:test";
import { attachmentImageType, checkAttachment, MAX_ATTACHMENT_BYTES } from "../src/attachments.ts";
import { parseConfig } from "../src/config.ts";
import { DEMO_TOML } from "./support.ts";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("images are byte-sniffed and limited; links require HTTPS", () => {
  expect(attachmentImageType(png)).toBe("image/png");
  expect(checkAttachment({ kind: "image", bytes: png, contentType: "image/png" })).toBeNull();
  expect(checkAttachment({ kind: "image", bytes: png, contentType: "image/jpeg" })).toContain("type");
  expect(
    checkAttachment({ kind: "image", bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1), contentType: "image/png" }),
  ).toContain("2 MB");
  expect(checkAttachment({ kind: "link", url: "https://example.com/design" })).toBeNull();
  expect(checkAttachment({ kind: "link", url: "http://example.com" })).toContain("HTTPS");
  expect(checkAttachment({ kind: "link", url: "https://person:secret@example.com" })).toContain("credentials");
  expect(checkAttachment({ kind: "link", url: "https://example.com/\r\nheader" })).toContain("control characters");
});

test("all four supported image types are recognized from bytes, never filenames", () => {
  expect(attachmentImageType(Uint8Array.from([255, 216, 255, 224]))).toBe("image/jpeg");
  expect(attachmentImageType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
  expect(attachmentImageType(new TextEncoder().encode("RIFF0000WEBPVP8 "))).toBe("image/webp");
  expect(attachmentImageType(new TextEncoder().encode("<svg />"))).toBeNull();
});

test("attachment quotas and retention are configurable positive integers", () => {
  const config = parseConfig(
    `${DEMO_TOML}\n[policy]\nattachments_per_ticket = 4\nattachments_project_mb = 8\nattachments_retention_days = 2\n`,
  );
  expect(config.policy.attachmentsPerTicket).toBe(4);
  expect(config.policy.attachmentsProjectMb).toBe(8);
  expect(config.policy.attachmentsRetentionDays).toBe(2);
  expect(() => parseConfig(`${DEMO_TOML}\n[policy]\nattachments_per_ticket = 0`)).toThrow("positive integer");
});
