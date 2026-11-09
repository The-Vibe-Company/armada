import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModalProvider } from "./provider.ts";
/** Explicit real-network conformance only. Same ephemeral-file lifecycle as main's secure SSH
 * executor: private key generated locally, never read/printed by Armada, deleted in finally. */
export interface GoldenSshRecipe {
  /** Actual trusted core goldenScript/baseline source. Never log it or pass credentials in argv. */
  script: string;
  githubToken?: string;
  timeoutMs?: number;
}
export async function probeModalSsh(
  provider: ModalProvider,
  sandboxId: string,
  recipe?: GoldenSshRecipe,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "armada-modal-ssh-"));
  try {
    const key = join(dir, "key");
    const known = join(dir, "known_hosts");
    const generate = Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await generate.exited) !== 0) throw Error("ephemeral_ssh_key_generation_failed");
    const connection = await provider.sshKey({ sandboxId, key: (await Bun.file(`${key}.pub`).text()).trim() });
    const endpoint =
      /^([^:\s]+):(\d+)$/.exec(connection.sshEndpoint) ?? /^\[([^\]]+)\]:(\d+)$/.exec(connection.sshEndpoint);
    if (
      !endpoint?.[1] ||
      !endpoint[2] ||
      Number(endpoint[2]) < 1 ||
      Number(endpoint[2]) > 65535 ||
      !/^ssh-ed25519 [A-Za-z0-9+/]+=*(?: [^\r\n]*)?$/.test(connection.hostKey)
    )
      throw Error("invalid_pinned_ssh_connection");
    const username = connection.username ?? "user";
    if (username !== "user" && username !== "root") throw Error("invalid_pinned_ssh_username");
    const host = endpoint[1];
    const port = endpoint[2];
    await writeFile(known, `[${host}]:${port} ${connection.hostKey}\n`, { mode: 0o600 });
    const ssh = Bun.spawn(
      [
        "ssh",
        "-i",
        key,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${known}`,
        "-o",
        "ConnectTimeout=20",
        "-p",
        port,
        `${username}@${host}`,
        ...(recipe
          ? [
              "env",
              "HOME=/home/user",
              "bash",
              "-c",
              "'set +x; IFS= read -r ARMADA_GIT_TOKEN; IFS= read -r ARMADA_SSH_PUBLIC_KEY; export ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY; bash -s; status=$?; unset ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY; history -c 2>/dev/null || true; exit $status'",
            ]
          : ["printf armada-pinned-ssh"]),
      ],
      {
        stdin: recipe ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: recipe ? "pipe" : "ignore",
        timeout: recipe?.timeoutMs ?? 30_000,
      },
    );
    if (recipe) {
      const input = ssh.stdin;
      if (!input || typeof input === "number") throw Error("missing_private_ssh_pipe");
      input.write(`${recipe.githubToken ?? ""}\n${(await Bun.file(`${key}.pub`).text()).trim()}\n${recipe.script}`);
      input.end();
    }
    const [exit, stdout, stderr] = await Promise.all([
      ssh.exited,
      new Response(ssh.stdout).text(),
      ssh.stderr ? new Response(ssh.stderr).text() : Promise.resolve(""),
    ]);
    if (exit !== 0) {
      const phase = /^ARMADA_BUILD_FAILURE ([a-z_]{1,40}) ([0-9]{1,3})$/m.exec(stderr);
      throw Error(phase ? `golden_ssh_recipe_failed:${phase[1]}:${phase[2]}` : "pinned_ssh_authentication_failed");
    }
    if (!recipe && stdout !== "armada-pinned-ssh") throw Error("pinned_ssh_authentication_failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
