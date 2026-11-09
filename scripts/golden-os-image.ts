/** Generate the OS conformance Dockerfile from the ACTUAL public provider image builder.
 * No Modal App/account/resource is created; only public fromRegistry/dockerfileCommands are captured.
 * Fixture setup must never supply missing sudo or repair the provider's private runner Bun path.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createRunnerDistribution,
  MODAL_IMAGE_LOCK,
  type RunnerDistribution,
} from "../packages/provider-modal/src/index.ts";

type Image = Awaited<ReturnType<RunnerDistribution["image"]>>;
type ModalClient = Parameters<RunnerDistribution["image"]>[0];

const root = join(import.meta.dir, "..");
const out = join(root, "dist/golden-os-fixture");
await mkdir(out, { recursive: true });
const bundle = new Uint8Array(await Bun.file(join(root, "packages/agent-runtime/dist/main.js")).arrayBuffer());
let registry: string | undefined;
let instructions: string[] | undefined;
const client = {
  images: {
    fromRegistry(base: string) {
      registry = base;
      return {
        dockerfileCommands(commands: string[]) {
          instructions = commands;
          return {} as Image;
        },
      };
    },
  },
} as unknown as ModalClient;
const unused = async (): Promise<never> => {
  throw new Error("OS recipe generator may only call image().");
};
const distribution = createRunnerDistribution({
  ...MODAL_IMAGE_LOCK,
  bundle,
  sha256: createHash("sha256").update(bundle).digest("hex"),
  // This tool only materializes image instructions, never serves a Provider or advertises harness capabilities.
  capabilities: {} as RunnerDistribution["capabilities"],
  bootstrap: unused,
  restoreEnv: unused,
  prepareSnapshot: unused,
});
await distribution.image(client);
if (!registry || !instructions?.length) throw new Error("Provider did not produce a public image recipe.");
await Bun.write(
  join(out, "Dockerfile"),
  [
    `FROM ${registry}`,
    ...instructions,
    "COPY source-fixture.sh /opt/armada/os-source-fixture.sh",
    "RUN bash /opt/armada/os-source-fixture.sh",
    "COPY git /usr/local/bin/git",
    "RUN chmod 0755 /usr/local/bin/git",
    "EXPOSE 22",
    'CMD ["/bin/sh","-c","ssh-keygen -A && exec /usr/sbin/sshd -D -e"]',
    "",
  ].join("\n"),
);
for (const file of ["git", "source-fixture.sh"])
  await copyFile(join(root, "scripts/fixtures/golden-os", file), join(out, file));
