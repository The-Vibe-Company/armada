/** Definite refusals leave the preceding accepted Docker prompt authoritative. */
export function isDockerPromptRefusal(status: unknown, body: unknown, requestId: string): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const reply = body as Record<string, unknown>;
  if (Object.hasOwn(reply, "result")) return false;
  const versioned = Object.hasOwn(reply, "version") || Object.hasOwn(reply, "requestId");
  if (versioned && (reply.version !== 1 || reply.requestId !== requestId)) return false;
  if (reply.error === "native_auth_writer_busy") return status === 409;
  return (
    (status === 400 || status === 409) && (reply.error === "conversation_busy" || reply.error === "invalid_request")
  );
}
