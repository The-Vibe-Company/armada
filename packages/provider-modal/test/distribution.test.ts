import { expect, test } from "bun:test";
import type { Image, ModalClient } from "modal";
import { MODAL_IMAGE_LOCK, modalImage } from "../src/index.ts";

test("the Modal golden image pins its toolchain and control Bun", async () => {
  let commands: string[] = [];
  const client = {
    images: {
      fromRegistry(base: string) {
        expect(base).toBe(MODAL_IMAGE_LOCK.base);
        return {
          dockerfileCommands(instructions: string[]) {
            commands = instructions;
            return {} as Image;
          },
        };
      },
    },
  } as unknown as ModalClient;
  await modalImage(MODAL_IMAGE_LOCK)(client);
  expect(commands[0]).toContain("python3-venv");
  expect(commands[0]).toContain("git-2.52.0.tar.xz");
  expect(commands[0]).toMatch(/apt-get install[^;]* 'libssl-dev'(?: |;)/);
  expect(commands[0]).toContain("/opt/armada/runtime-bun/bun");
});
