import type { Sandbox } from "modal";
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

export async function dispatchRuntimeBootstrap(
  sandbox: Sandbox,
  command: string[],
  serverUrl: string,
  enrolmentToken: string,
  failureMessage: string,
) {
  try {
    const child = await sandbox.exec(["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", ...command], {
      env: {},
      secrets: [],
      timeoutMs: 150_000,
      workdir: "/home/user",
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.stdin.writeText(JSON.stringify({ serverUrl, enrolmentToken }));
    await child.stdin.close();
    if ((await child.wait()) === 0) return;
  } catch {
    throw refusal("unavailable", failureMessage);
  }
  throw refusal("unavailable", failureMessage);
}
