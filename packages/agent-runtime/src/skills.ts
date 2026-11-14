import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_CATALOG, type Harness, type SkillReceipt, validateSkillPins } from "@armada/core";
import { shellQuote as q } from "../../core/src/shell-quote.ts";
import {
  parsePrivateSkillReceipt,
  parseSkillReceipt,
  skillExclusionCommand,
  skillInstallCommand,
} from "../../core/src/skillpack.ts";
import { SKILLPACK_TOKEN_PATTERN } from "../../core/src/skillpack-token.ts";
import type { Journal } from "./journal.ts";
import { groupState, processIdentity } from "./processes.ts";
import { prepareRuntimeSkillpack } from "./skillpack-prepare.ts";

export interface SkillInstallInput {
  harness: Harness;
  references: string[];
  cwd: string;
  key?: string;
}
/** Fixed, foreground installer. No model credentials, arbitrary command, key argv
 * or global environment mutation. All diagnostics are closed labels. */
export async function installRuntimeSkills(
  input: SkillInstallInput,
  journal: Journal,
  environment: Readonly<Record<string, string>>,
  signal: AbortSignal,
  fetcher: (url: URL, options: RequestInit) => Promise<Response> = fetch,
): Promise<SkillReceipt[]> {
  validateSkillPins(input.references);
  const privatePins = input.references.some((ref) => !ref.includes("/"));
  if (privatePins && !input.key) throw Error("skillpack_credential_missing");
  if (input.key && !new RegExp(`^${SKILLPACK_TOKEN_PATTERN}$`).test(input.key))
    throw Error("skillpack_credential_unreadable");
  if (input.key) journal.registerSecrets([input.key]);
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(300000)]);
  const prepared = await prepareRuntimeSkillpack(environment, bounded, fetcher);
  try {
    const run = async (command: string, key?: string) => {
      bounded.throwIfAborted();
      const child = spawn("/bin/bash", ["-s"], {
        cwd: input.cwd,
        detached: true,
        env: {
          ...environment,
          PATH: prepared.path,
          SKILLPACK_TELEMETRY: "0",
          ...(key ? { SKILLPACK_API_KEY: key } : {}),
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      child.stdin.on("error", () => {});
      let stdout = "",
        truncated = false,
        aborted = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length + chunk.length > 1048576) {
          truncated = true;
          terminate();
        } else stdout += chunk.toString();
      });
      const closed = new Promise<number | null>((resolve) => {
        child.once("close", resolve);
        child.once("error", () => resolve(null));
      });
      let identity: ReturnType<typeof processIdentity>;
      const terminate = () => {
        aborted = true;
        child.stdin.destroy();
        try {
          if (child.pid && identity && groupState(child.pid, identity) === "live") process.kill(-child.pid, "SIGKILL");
          else if (!identity) child.kill("SIGKILL");
        } catch {}
      };
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        // The shell is still waiting for stdin: refuse BEFORE executable code can
        // create descendants if process-group ownership cannot be authenticated.
        try {
          identity = processIdentity(child.pid!);
        } catch {}
        if (!identity) {
          terminate();
          await closed;
          throw Error("skillpack_process_failed");
        }
        journal.db
          .query("INSERT OR REPLACE INTO processes VALUES(?,?)")
          .run(child.pid!, JSON.stringify({ pid: child.pid, status: "running", identity }));
        bounded.addEventListener("abort", terminate, { once: true });
        if (bounded.aborted) terminate();
        else child.stdin.end(`set +x\n${command}\n`);
        const code = await closed;
        // A foreground CLI must not leave background writers or inherited keys.
        let state: "live" | "gone" | "unverifiable" = "unverifiable";
        try {
          state = groupState(child.pid!, identity);
        } catch {}
        if (state !== "gone") {
          terminate();
          throw Error("skillpack_process_failed");
        }
        if (truncated) throw Error("skillpack_protocol_invalid");
        if (aborted || bounded.aborted) throw Error("skillpack_timeout");
        return { code, stdout };
      } catch (error) {
        terminate();
        await closed;
        if (error instanceof Error && error.message.startsWith("skillpack_")) throw error;
        throw Error("skillpack_cli_unavailable");
      } finally {
        bounded.removeEventListener("abort", terminate);
        if (child.pid)
          journal.db
            .query("INSERT OR REPLACE INTO processes VALUES(?,?)")
            .run(child.pid, JSON.stringify({ pid: child.pid, status: "exited", identity }));
      }
    };
    let workspace: string | undefined;
    if (privatePins) {
      const auth = await run("skillpack auth status --api-url https://skillpack.app/v1 --json", input.key);
      if (auth.code !== 0)
        throw Error(
          [3, 7].includes(auth.code ?? -1)
            ? "skillpack_credential_refused"
            : [2, 126, 127].includes(auth.code ?? -1)
              ? "skillpack_cli_unavailable"
              : "skillpack_auth_unavailable",
        );
      try {
        const parsed = JSON.parse(auth.stdout);
        workspace = parsed?.workspace?.id;
      } catch {}
      if (typeof workspace !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(workspace))
        throw Error("skillpack_protocol_invalid");
    }
    const receipts: SkillReceipt[] = [];
    for (const reference of input.references) {
      bounded.throwIfAborted();
      const isPrivate = !reference.includes("/");
      const [slug, version] = reference.split("@");
      const command = isPrivate
        ? `skillpack install ${q(slug!)} --version ${q(version!)} --scope project --project ${q(input.cwd)} --tools ${HARNESS_CATALOG[input.harness].skillpackTool} --pin --yes --api-url https://skillpack.app/v1 --json`
        : skillInstallCommand(reference, input.cwd, input.harness);
      const result = await run(`${command} >/dev/null`, isPrivate ? input.key : undefined);
      if (result.code !== 0)
        throw Error(
          result.code === 3
            ? isPrivate
              ? "skillpack_credential_refused"
              : "skillpack_skill_unavailable"
            : [4, 7].includes(result.code ?? -1)
              ? "skillpack_skill_unavailable"
              : result.code === 2 || result.code === 5
                ? "skillpack_request_rejected"
                : result.code === 6
                  ? "skillpack_install_conflict"
                  : result.code === 8
                    ? "skillpack_registry_unavailable"
                    : [126, 127].includes(result.code ?? -1)
                      ? "skillpack_cli_unavailable"
                      : "skillpack_install_nonzero",
        );
      try {
        const path = join(input.cwd, ".companion/skills.lock.json");
        if ((await stat(path)).size > 1048576) throw Error();
        const lock = await readFile(path, "utf8");
        receipts.push(
          isPrivate
            ? parsePrivateSkillReceipt(lock, reference, input.harness, workspace!)
            : parseSkillReceipt(lock, reference, input.harness),
        );
      } catch {
        throw Error("skillpack_receipt_invalid");
      }
    }
    const exclusions = await run(skillExclusionCommand(input.references, input.harness));
    // /home/user can be a non-repository golden; native launch only excludes in repos.
    if (exclusions.code !== 0 && input.cwd !== "/home/user") throw Error("skillpack_install_state_invalid");
    return receipts;
  } finally {
    await prepared.dispose();
  }
}
