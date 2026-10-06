import { expect, test } from "bun:test";
import type { Attachment, Validation } from "@armada/core/read";
import { galleryOf } from "../lib/fleet-data";

const validation: Validation = {
  id: 1,
  project: "widgets",
  ticket: "WID-7",
  kind: "validation",
  what: "Check the card",
  reason: null,
  choices: null,
  pr: null,
  attachments: [],
  author: null,
  createdAt: "2026-01-01T00:00:00Z",
  decision: null,
};
const image = (n: number, over: Partial<Attachment> = {}): Attachment => ({
  id: `image-${n}`,
  project: "widgets",
  ticket: "WID-7",
  kind: "image",
  contentType: "image/png",
  size: 1,
  sha256: "synthetic",
  caption: null,
  author: "Ada",
  createdAt: `2026-01-0${n}T00:00:00Z`,
  reference: null,
  url: null,
  ...over,
});

test("the fallback gallery shows the newest four ticket images and counts the rest, while explicit samples keep their order", () => {
  const attachments = [
    image(2),
    image(6),
    image(1),
    image(3),
    image(5),
    image(4),
    image(7, { kind: "link", url: "https://example.test" }),
    image(8, { ticket: "WID-8" }),
    image(9, { project: "other" }),
  ];
  const fallback = galleryOf(validation, attachments);
  expect(fallback.gallery.map((a) => a.id)).toEqual(["image-6", "image-5", "image-4", "image-3"]);
  expect(fallback.more).toBe(2);
  expect(galleryOf(validation, attachments, 8).gallery).toHaveLength(6);
  const explicit = galleryOf({ ...validation, attachments: ["image-1", "image-3", "image-8", "image-9"] }, attachments);
  expect(explicit.gallery.map((a) => a.id)).toEqual(["image-1", "image-3"]);
  expect(explicit.more).toBe(0);
  expect(
    galleryOf({ ...validation, excerpts: Array(3).fill({ label: "output", text: "sample" }) }, attachments).gallery,
  ).toHaveLength(2);
});
