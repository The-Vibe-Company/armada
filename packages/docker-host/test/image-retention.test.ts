import { expect, test } from "bun:test";
import { supersededOfficialImages } from "../src/image-retention.ts";

const id = (n: number) => `sha256:${String(n).padStart(64, "0")}`;
const image = (n: number) => ({
  Id: id(n),
  Created: `2026-11-${String(n).padStart(2, "0")}T00:00:00Z`,
  RepoDigests: [`ghcr.io/the-vibe-company/armada-sandbox@${id(n)}`],
});
test("keeps two newest official generations and all container, snapshot and foreign references", () => {
  const images = [
    image(1),
    image(2),
    image(3),
    image(4),
    image(5),
    image(6),
    { ...image(7), RepoDigests: ["foreign@digest"] },
    { ...image(8), Config: { Labels: { "dev.armada.environment.snapshot": "snapshot" } }, Parent: id(2) },
  ];
  expect(supersededOfficialImages(images, [id(1)])).toEqual([id(4), id(3)]);
  expect(supersededOfficialImages([image(1), image(2)], [])).toEqual([]);
});
