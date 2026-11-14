export interface EnvironmentDigestIo {
  request<T>(path: string, body: object): Promise<T>;
  poll<T>(read: () => Promise<T>, done: (value: T) => boolean, attempts: number, until: number): Promise<T>;
  until: number;
}

/** Shared exact final-parent oracle for readable and secret canary delivery. */
export async function verifyEnvironmentDigest(
  id: string,
  provider: "boat" | "modal" | "docker",
  command: string,
  expected: string,
  io: EnvironmentDigestIo,
  fail: (code: "delivery_mismatch" | "invalid_receipt" | "turn_failed") => never,
) {
  const prompt = `Use your terminal tool to run exactly this command: ${command}\nReply with only its SHA-256 digest, no formatting or other text. Do not modify files or print environment values.`;
  const execution = await io.request<{ exitCode?: number; timedOut?: boolean; stdout?: string }>("sandbox/exec", {
    id,
    command,
    cwd: "/tmp",
    timeout_seconds: 30,
    ...(provider === "docker" ? { request_id: crypto.randomUUID() } : {}),
  });
  if (execution?.exitCode !== 0 || execution.timedOut !== false || execution.stdout?.trim() !== expected)
    fail("delivery_mismatch");
  const turn = await io.request<{ promptId?: string }>("sandbox/send", {
    id,
    prompt,
    ...(provider === "docker" ? { request_id: crypto.randomUUID() } : {}),
  });
  if (typeof turn?.promptId !== "string" || !turn.promptId) fail("invalid_receipt");
  let cursor: string | undefined;
  let finished = false;
  let lastParent: string | undefined;
  const messages = new Map<string, { text: string; eligible: boolean }>();
  await io.poll(
    () =>
      io.request<{
        cursor?: string;
        hasMore?: boolean;
        events?: Array<{
          id: string;
          messageId?: string;
          kind: string;
          promptId?: string;
          status?: string;
          text?: string;
          textMode?: string;
          partial?: boolean;
          responseKind?: string;
          parentToolUseId?: string;
          retracted?: boolean;
        }>;
      }>("logs/read", {
        id,
        coalesce: true,
        limit: 200,
        maxBytes: 262144,
        ...(cursor ? { cursor } : {}),
      }),
    (page) => {
      if (!Array.isArray(page?.events)) fail("invalid_receipt");
      cursor = page.cursor;
      for (const event of page.events) {
        if (event.promptId !== turn.promptId) continue;
        if (event.kind === "prompt") {
          if (["failed", "interrupted"].includes(event.status ?? "")) fail("turn_failed");
          finished ||= event.status === "finished";
        }
        if (event.kind !== "message" || typeof event.id !== "string") continue;
        const key = event.messageId ?? event.id;
        if (!event.parentToolUseId && event.responseKind !== "tool_result") lastParent = key;
        const text =
          event.textMode === "delta" ? (messages.get(key)?.text ?? "") + (event.text ?? "") : (event.text ?? "");
        messages.set(key, {
          text: text.slice(0, 4096),
          eligible:
            text.length <= 4096 &&
            event.partial === false &&
            !event.parentToolUseId &&
            event.responseKind !== "tool_result" &&
            !event.retracted,
        });
      }
      const answer = lastParent ? messages.get(lastParent) : undefined;
      return page.hasMore !== true && finished && answer?.eligible === true && answer.text.trim() === expected;
    },
    110,
    io.until,
  );
}
