import type { DockerMachineCli } from "../../core/src/docker-machine.ts";

const repository = "ghcr.io/the-vibe-company/armada-sandbox";
const imageId = /^sha256:[a-f0-9]{64}$/;
type Image = {
  Id: string;
  Created: string;
  RepoTags?: string[];
  RepoDigests?: string[];
  Parent?: string;
  Config?: { Labels?: Record<string, string> };
};

/** Registry provenance, not dangling status, identifies official images. Keep two generations.
 * All containers (including foreign/stopped ones) and descendants protect their ancestors.
 */
export function supersededOfficialImages(images: Image[], containerImages: string[]): string[] {
  const official = images
    .filter(
      (image) =>
        imageId.test(image.Id) &&
        Number.isFinite(Date.parse(image.Created)) &&
        image.RepoDigests?.some((ref) => ref.startsWith(`${repository}@sha256:`)) &&
        image.RepoDigests.every((ref) => ref.startsWith(`${repository}@sha256:`)) &&
        (image.RepoTags ?? []).every((ref) => ref.startsWith(`${repository}:`)) &&
        !Object.keys(image.Config?.Labels ?? {}).some((key) => key.startsWith("dev.armada.environment.")),
    )
    .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created) || a.Id.localeCompare(b.Id));
  const protectedIds = new Set([...containerImages, ...official.slice(0, 2).map((image) => image.Id)]);
  for (const image of images) if (image.Parent) protectedIds.add(image.Parent);
  return official
    .slice(2)
    .filter((image) => !protectedIds.has(image.Id))
    .map((image) => image.Id);
}

/** No force and no prune: Docker remains the final reference/descendant race guard. */
export async function cleanupOfficialImages(cli: DockerMachineCli): Promise<void> {
  const run = async (args: string[]) => {
    const result = await cli.run(args);
    if (result.exitCode !== 0) throw Error("Image retention inventory unavailable");
    return result.stdout.trim();
  };
  const ids = (await run(["image", "ls", "--all", "--quiet", "--no-trunc"])).split("\n").filter(Boolean);
  if (!ids.length) return;
  if (ids.some((id) => !imageId.test(id))) throw Error("Invalid image inventory");
  const images: Image[] = JSON.parse(await run(["image", "inspect", ...new Set(ids)]));
  const containers = (await run(["container", "ls", "--all", "--quiet", "--no-trunc"])).split("\n").filter(Boolean);
  if (containers.some((id) => !/^[a-f0-9]{64}$/.test(id))) throw Error("Invalid container inventory");
  const used = containers.length
    ? (JSON.parse(await run(["container", "inspect", ...containers])) as { Image: string }[]).map((c) => c.Image)
    : [];
  // One deletion per sweep bounds work; subsequent sweeps retry conflicts safely.
  const candidate = supersededOfficialImages(images, used)[0];
  if (candidate) await run(["image", "rm", candidate]);
}
