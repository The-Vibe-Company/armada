import { createHash, createHmac } from "node:crypto";

/** Translate a canonical launch key into Docker's durable reservation identifier. */
export function dockerLaunchRequestId(secret: string, userId: string, orgId: string, key: string): string {
  // Clients can choose legacy reservation UUIDs. A server key prevents another
  // caller from computing a keyed launch's UUID and claiming it first.
  const digest = createHmac("sha256", Buffer.from(secret, "base64"))
    .update(JSON.stringify(["docker-launch-key-v1", userId.toLowerCase(), orgId, key]))
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

const hash = (request: object) => createHash("sha256").update(JSON.stringify(request)).digest("hex");

/** Release-selected image bytes are frozen server state, not caller retry identity. */
export function dockerLaunchRequestHash(request: { image: string }): string {
  const { image: _image, ...callerRequest } = request;
  return hash(callerRequest);
}

/** Retained pre-official-image admissions keep their original full-request hashes. */
export function matchesDockerLaunchRequestHash(request: unknown, expected: string): boolean {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    !("image" in request) ||
    typeof request.image !== "string"
  )
    return false;
  return expected === dockerLaunchRequestHash(request as { image: string }) || expected === hash(request);
}
