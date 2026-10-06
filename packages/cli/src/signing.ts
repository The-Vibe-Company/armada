import { type SigningConfig, type SigningSetup, signingSetup } from "@armada/core";
import type { Io } from "./io.ts";

/** Predict from config only: no signatures or interactive prompts on a normal doctor run. */
export async function readSigning(io: Io, root: string, timeoutMs = 10_000): Promise<SigningSetup | null> {
  if (!io.exec) return null;
  const config: SigningConfig = {};
  for (const key of [
    "commit.gpgsign",
    "gpg.format",
    "gpg.ssh.program",
    "gpg.x509.program",
    "user.signingkey",
  ] as const) {
    const result = await io
      .exec("git", ["config", ...(key === "commit.gpgsign" ? ["--bool"] : []), "--get", key], {
        cwd: root,
        timeoutMs,
        processGroup: true,
        env: { ...io.env, GIT_TERMINAL_PROMPT: "0" },
        maxOutputBytes: 16_384,
      })
      .catch(() => null);
    // Exit 1 means the key is unset, not that Git failed to read it.
    if (!result || result.timedOut || result.outputExceeded || (result.code !== 0 && result.code !== 1)) return null;
    if (result.code === 0) config[key] = result.stdout.trim();
  }
  // Git's legacy/canonical OpenPGP keys are aliases: the last encountered
  // entry wins, including across scopes. Read them together in config order.
  const programs = await io
    .exec("git", ["config", "--null", "--get-regexp", "^gpg\\.(openpgp\\.)?program$"], {
      cwd: root,
      timeoutMs,
      processGroup: true,
      env: { ...io.env, GIT_TERMINAL_PROMPT: "0" },
      maxOutputBytes: 16_384,
    })
    .catch(() => null);
  if (!programs || programs.timedOut || programs.outputExceeded || (programs.code !== 0 && programs.code !== 1))
    return null;
  if (programs.code === 0) {
    const entries = programs.stdout.split("\0").filter(Boolean);
    const last = entries.at(-1);
    if (last) config.openpgpProgram = last.slice(last.indexOf("\n") + 1).trim();
  }
  const setup = signingSetup(config);
  if (setup.enabled && (setup.format === "openpgp" || setup.format === "x509")) {
    const result = await io
      .exec("gpgconf", ["--list-options", "gpg-agent"], {
        cwd: root,
        timeoutMs,
        processGroup: true,
        env: { ...io.env, GIT_TERMINAL_PROMPT: "0" },
        maxOutputBytes: 65_536,
      })
      .catch(() => null);
    if (result?.code === 0 && !result.timedOut && !result.outputExceeded) {
      // gpgconf fields: name:flags:level:description:type:alt-type:argname:default:argdef:value.
      const fields = result.stdout
        .split("\n")
        .find((line) => line.startsWith("pinentry-program:"))
        ?.split(":");
      const value = fields?.[9] || fields?.[7];
      if (value) {
        try {
          config.pinentryProgram = decodeURIComponent(value.replace(/^"/, ""));
        } catch {
          /* Unreadable pinentry cannot be classified. */
        }
      }
    }
  }
  return signingSetup(config);
}
