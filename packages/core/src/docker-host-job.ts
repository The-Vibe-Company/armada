import { isDockerImageReference } from "./docker-image.ts";
import type { DockerMachineRequest } from "./docker-machine.ts";

export type BootstrapDescriptor = {
  serverUrl: string;
  artifact: { sha256: string; bytes: number };
  enrolmentToken: string;
};
export type DockerHostJob = { requestId: string; request: DockerMachineRequest } & (
  | { operation: "create" | "stop" | "delete" }
  | { operation: "bootstrap" | "resume"; bootstrap: BootstrapDescriptor }
);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function invalid(): never {
  throw new Error("Invalid host job");
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid();
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !uuid.test(value)) invalid();
}
/** Shared strict mailbox admission, with no network, cryptography or filesystem dependencies. */
export function parseDockerHostJob(value: unknown): DockerHostJob {
  if (!value || typeof value !== "object") invalid();
  const bootstrap = "operation" in value && (value.operation === "bootstrap" || value.operation === "resume");
  exact(value, ["requestId", "operation", "request", ...(bootstrap ? ["bootstrap"] : [])]);
  id(value.requestId);
  if (
    typeof value.operation !== "string" ||
    !["create", "stop", "delete", "bootstrap", "resume"].includes(value.operation)
  )
    invalid();
  const r = value.request;
  const absolute = r !== null && typeof r === "object" && Object.hasOwn(r, "expiresAt");
  exact(r, ["sandboxId", "generation", "image", "ttlSeconds", ...(absolute ? ["expiresAt"] : [])]);
  id(r.sandboxId);
  id(r.generation);
  if (
    !isDockerImageReference(r.image) ||
    typeof r.ttlSeconds !== "number" ||
    !Number.isInteger(r.ttlSeconds) ||
    r.ttlSeconds < 1 ||
    r.ttlSeconds > 86_400
  )
    invalid();
  const request: DockerMachineRequest = {
    sandboxId: r.sandboxId,
    generation: r.generation,
    image: r.image,
    ttlSeconds: r.ttlSeconds,
  };
  if (absolute) {
    const end = r.expiresAt;
    if (typeof end !== "number" || !Number.isSafeInteger(end) || end <= 0 || end > 8_640_000_000_000_000) invalid();
    request.expiresAt = end;
  }
  if (!bootstrap)
    return { requestId: value.requestId, operation: value.operation as "create" | "stop" | "delete", request };
  const b = value.bootstrap;
  exact(b, ["serverUrl", "artifact", "enrolmentToken"]);
  exact(b.artifact, ["sha256", "bytes"]);
  if (
    typeof b.serverUrl !== "string" ||
    !/^https:\/\/[^\\/?#]+\/?$/i.test(b.serverUrl) ||
    typeof b.enrolmentToken !== "string" ||
    !/^armada_enrol_[0-9a-f]{64}$/.test(b.enrolmentToken) ||
    typeof b.artifact.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(b.artifact.sha256) ||
    typeof b.artifact.bytes !== "number" ||
    !Number.isInteger(b.artifact.bytes) ||
    b.artifact.bytes < 1 ||
    b.artifact.bytes > 512 * 1024 * 1024
  )
    invalid();
  let url: URL;
  try {
    url = new URL(b.serverUrl);
  } catch {
    return invalid();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    invalid();
  return {
    requestId: value.requestId,
    operation: value.operation as "bootstrap" | "resume",
    request,
    bootstrap: {
      serverUrl: url.origin,
      artifact: { sha256: b.artifact.sha256, bytes: b.artifact.bytes },
      enrolmentToken: b.enrolmentToken,
    },
  };
}
/** Preserve the pre-bootstrap stored machine-job bytes, including property order. */
export function canonicalDockerHostJob(value: unknown): string {
  const job = parseDockerHostJob(value);
  return JSON.stringify({
    operation: job.operation,
    request: job.request,
    ...(job.operation === "bootstrap" || job.operation === "resume" ? { bootstrap: job.bootstrap } : {}),
  });
}
