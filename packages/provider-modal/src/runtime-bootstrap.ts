import { createHash } from "node:crypto";
import { runtimeBootstrapScript, SHARED_ARTIFACT_CACHE_PATH } from "@armada/core/server";
import type { Sandbox } from "modal";
import { modalStopTimeout } from "./client.ts";
import { refusal } from "./errors.ts";

export type RuntimeTicket = {
  serverUrl: string;
  artifact: { sha256: string; bytes: number };
  cacheDir: string;
  enrolmentToken: string;
};

export function validateRuntimeTicket(ticket: RuntimeTicket) {
  const server = new URL(ticket.serverUrl);
  if (
    server.protocol !== "https:" ||
    server.origin !== ticket.serverUrl.replace(/\/$/, "") ||
    !ticket.cacheDir.startsWith("/") ||
    ticket.cacheDir === "/" ||
    ticket.cacheDir.includes("\0") ||
    !/^[a-f0-9]{64}$/.test(ticket.artifact.sha256) ||
    !Number.isSafeInteger(ticket.artifact.bytes) ||
    ticket.artifact.bytes <= 0 ||
    ticket.artifact.bytes > 512 * 1024 * 1024 ||
    !/^armada_enrol_[a-f0-9]{64}$/.test(ticket.enrolmentToken)
  )
    throw refusal("invalid_request", "Invalid enrolled Modal bootstrap.");
  return server.origin;
}

export async function bootstrapModalRuntime(
  sandbox: Sandbox,
  machineId: string,
  serverUrl: string,
  ticket: RuntimeTicket,
  failureMessage: string,
) {
  const lock = `/run/armada-runtime-${createHash("sha256").update(JSON.stringify(machineId)).digest("hex")}.lock`;
  const baseScript = runtimeBootstrapScript(serverUrl, ticket.artifact, ticket.cacheDir, SHARED_ARTIFACT_CACHE_PATH);
  const stdio = "stdio:['pipe','ignore','ignore']";
  if (!baseScript.includes(stdio)) throw refusal("unavailable", "Modal bootstrap could not pass its runtime lock.");
  const script = baseScript.replace(stdio, "stdio:['pipe','ignore','ignore',9]");
  const lockAndExec = `exec 9>"$1" || exit 1
shift
flock -n -E 75 9
case $? in
  0) exec "$@" ;;
  75) cat >/dev/null; exit 75 ;;
  *) exit 1 ;;
esac`;
  try {
    const child = await sandbox.exec(
      [
        "/usr/bin/env",
        "-i",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "sh",
        "-c",
        lockAndExec,
        "sh",
        lock,
        "node",
        "-e",
        script,
      ],
      {
        env: {},
        secrets: [],
        timeoutMs: modalStopTimeout(150_000, 1_000),
        workdir: "/home/user",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    await child.stdin.writeText(JSON.stringify({ serverUrl, enrolmentToken: ticket.enrolmentToken }));
    await child.stdin.close();
    if ((await child.wait()) === 0) return;
  } catch {
    throw refusal("unavailable", failureMessage);
  }
  throw refusal("unavailable", failureMessage);
}
