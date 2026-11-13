import { createHash } from "node:crypto";

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
