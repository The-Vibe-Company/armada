export class ExpirySmokeFailure extends Error {
  constructor(readonly code: "invalid_receipt" | "expiry_not_stopped" | "poll_limit_exceeded") {
    super(code);
  }
}
interface Case {
  org: string;
  golden: string;
  provider: "modal";
  harness: string;
  model: string;
  modelAccountId: string;
  reasoningEffort?: string;
}
interface Io {
  request<T>(path: string, body: object): Promise<T>;
  step<T>(name: string, action: () => Promise<T>): Promise<T>;
  withCleanup<T>(action: () => Promise<T>): Promise<T>;
  sleep(ms: number): Promise<void>;
  now(): number;
  out(line: string): void;
}
interface Status {
  id: string;
  status: string;
  providerState: string;
  statusReason?: string | null;
  expiresAt: string | null;
}
const TTL = 120;
const ACK = "EXPIRY_ACK";
interface JournalEvent {
  kind: string;
  promptId?: string;
  status?: string;
  text?: string;
  partial?: boolean;
  parentToolUseId?: string;
  responseKind?: string;
  retracted?: boolean;
}
interface JournalPage {
  events: JournalEvent[];
  cursor?: string;
  hasMore?: boolean;
}
interface JournalEntry extends JournalEvent {
  id?: string;
  messageId?: string;
  textMode?: string;
}
/** Observe the ordinary TTL lane; a manual cleanup stop can never count as expiry proof. */
export async function runExpiryCase(item: Case, io: Io): Promise<boolean> {
  const startedAt = io.now();
  const initialToken = `ARMADA_EXPIRY_${crypto.randomUUID()}`;
  const recoveryToken = `ARMADA_RECOVERY_${crypto.randomUUID()}`;
  let id: string | undefined;
  let conversation: string | undefined;
  let attempted = false;
  let stopped = false;
  let passed = true;
  const api = <T>(action: string, body: object) => io.request<T>(`sandbox/${action}`, { org: item.org, ...body });
  const physicalStop = (status: Status) => status.status === "stopped" && status.providerState === "stopped";
  async function observe(done: (status: Status) => boolean | Promise<boolean>, polls: number): Promise<Status> {
    for (let i = 0; i < polls; i++) {
      const status = await api<Status>("status", { id });
      if (status?.id !== id) throw new ExpirySmokeFailure("invalid_receipt");
      if (await done(status)) return status;
      if (i + 1 < polls) await io.sleep(1000);
    }
    throw new ExpirySmokeFailure("poll_limit_exceeded");
  }
  interface Metadata {
    id: string;
    provider: string;
    harness: string;
    status: string;
    effectiveTtlSeconds: number | null;
    expiresAt: string | null;
    stoppedAt: string | null;
  }
  async function verifyTurn(name: string, promptId: string, expected: string): Promise<void> {
    await io.step(name, async () => {
      let cursor: string | undefined;
      let finished = false;
      let failed = false;
      const messages = new Map<string, { text: string; eligible: boolean }>();
      let finalMessage: string | undefined;
      for (let poll = 0; poll < 360; poll++) {
        const page = await io.request<JournalPage>("logs/read", {
          org: item.org,
          id,
          all: true,
          ...(cursor ? { cursor } : {}),
        });
        if (!Array.isArray(page?.events)) throw new ExpirySmokeFailure("invalid_receipt");
        for (const raw of page.events as JournalEntry[]) {
          if (raw.promptId !== promptId) continue;
          if (raw.kind === "prompt") {
            if (raw.status === "failed" || raw.status === "interrupted") failed = true;
            if (raw.status === "finished") finished = true;
          }
          if (raw.kind !== "message" || typeof raw.id !== "string") continue;
          const key = raw.messageId ?? raw.id;
          if (!raw.parentToolUseId && raw.responseKind !== "tool_result") finalMessage = key;
          const text = raw.textMode === "delta" ? (messages.get(key)?.text ?? "") + (raw.text ?? "") : (raw.text ?? "");
          messages.set(key, {
            text: text.slice(0, 4096),
            eligible:
              text.length <= 4096 &&
              raw.partial === false &&
              !raw.parentToolUseId &&
              raw.responseKind !== "tool_result" &&
              !raw.retracted,
          });
        }
        if (failed) throw new ExpirySmokeFailure("invalid_receipt");
        cursor = page.cursor ?? cursor;
        const answer = finalMessage ? messages.get(finalMessage) : undefined;
        if (page.hasMore !== true && finished && answer?.eligible && answer.text.trim() === expected) return;
        await io.sleep(1000);
      }
      throw new ExpirySmokeFailure("poll_limit_exceeded");
    });
  }
  function freshDeadline(row: Metadata, expiresAt: string | null, sentAt: number): void {
    const deadline = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
    if (
      row.effectiveTtlSeconds !== TTL ||
      row.expiresAt !== expiresAt ||
      !Number.isFinite(deadline) ||
      deadline < sentAt + TTL * 1000 ||
      deadline > io.now() + TTL * 1000 + 10_000
    )
      throw new ExpirySmokeFailure("invalid_receipt");
  }
  async function metadata(): Promise<Metadata> {
    for (let page = 1; page <= 20; page++) {
      const result = await api<{ sandboxes: Metadata[]; page: number; hasMore: boolean; nextPage: number | null }>(
        "list",
        { owner: "me", harness: item.harness, page, limit: 200 },
      );
      if (!Array.isArray(result?.sandboxes) || result.page !== page) throw new ExpirySmokeFailure("invalid_receipt");
      const matches = result.sandboxes.filter((row) => row.id === id);
      if (matches.length === 1) {
        const row = matches[0]!;
        if (row.provider !== item.provider || row.harness !== item.harness)
          throw new ExpirySmokeFailure("invalid_receipt");
        return row;
      }
      if (matches.length > 1 || !result.hasMore || result.nextPage !== page + 1)
        throw new ExpirySmokeFailure("invalid_receipt");
    }
    throw new ExpirySmokeFailure("poll_limit_exceeded");
  }
  try {
    await io.step("expiry_launch", async () => {
      attempted = true;
      const result = await api<{
        sandbox: { id: string; provider: string; conversationIds?: string[] };
        promptId?: string | null;
        conversationId?: string | null;
      }>("launch", {
        golden: item.golden,
        provider: item.provider,
        harness: item.harness,
        model: item.model,
        credentialId: item.modelAccountId,
        ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
        prompt: `Remember this token for a later turn: ${initialToken}. Reply with exactly ${ACK} and do not use tools.`,
        connections: [],
        skipSkillDefaults: true,
        ttlSeconds: TTL,
      });
      if (typeof result?.sandbox?.id === "string" && result.sandbox.id) id = result.sandbox.id;
      if (
        !id ||
        result.sandbox.provider !== item.provider ||
        typeof result.promptId !== "string" ||
        !result.promptId ||
        typeof result.conversationId !== "string" ||
        !result.conversationId ||
        !Array.isArray(result.sandbox.conversationIds) ||
        result.sandbox.conversationIds.length !== 1 ||
        result.sandbox.conversationIds[0] !== result.conversationId
      )
        throw new ExpirySmokeFailure("invalid_receipt");
      conversation = result.conversationId;
      await verifyTurn("expiry_initial_recall", result.promptId, ACK);
    });
    const ready = await io.step("expiry_ready", () =>
      observe((status) => {
        if (["failed", "stopped", "stopping"].includes(status.status))
          throw new ExpirySmokeFailure("expiry_not_stopped");
        return status.status === "ready";
      }, 120),
    );
    io.out(
      JSON.stringify({
        step: "expiry_time_to_ready",
        pass: true,
        provider: item.provider,
        harness: item.harness,
        elapsedMs: io.now() - startedAt,
      }),
    );
    const expiresAt = ready.expiresAt;
    await io.step("expiry_deadline", async () => freshDeadline(await metadata(), expiresAt, startedAt));
    await io.step("expiry_as_stop", async () => {
      await observe((status) => {
        if (status.expiresAt !== expiresAt || status.status === "failed")
          throw new ExpirySmokeFailure("expiry_not_stopped");
        if (!physicalStop(status)) return false;
        if (status.statusReason !== "expired") throw new ExpirySmokeFailure("expiry_not_stopped");
        return true;
      }, 360);
      const row = await metadata();
      if (
        row.status !== "stopped" ||
        row.expiresAt !== expiresAt ||
        !row.stoppedAt ||
        !(Date.parse(row.stoppedAt) >= Date.parse(expiresAt!))
      )
        throw new ExpirySmokeFailure("expiry_not_stopped");
    });
    await io.step("expiry_recovery", async () => {
      const sentAt = io.now();
      const recovered = await api<{ promptId?: string | null; conversationId?: string | null }>("send", {
        id,
        prompt: `What ARMADA_EXPIRY_ token did I ask you to remember? Reply with only that token, without tools. Also remember ${recoveryToken} for a future turn.`,
      });
      if (
        typeof recovered.promptId !== "string" ||
        !recovered.promptId ||
        recovered.conversationId !== conversation ||
        !conversation
      )
        throw new ExpirySmokeFailure("invalid_receipt");
      await verifyTurn("expiry_recovered_recall", recovered.promptId, initialToken);
      const status = await api<Status>("status", { id });
      if (status.id !== id || status.expiresAt === expiresAt) throw new ExpirySmokeFailure("invalid_receipt");
      freshDeadline(await metadata(), status.expiresAt, sentAt);
    });
  } catch {
    passed = false; // step reports the closed reason; never print a response or provider exception.
  } finally {
    if (id && !stopped) {
      await io.withCleanup(async () => {
        try {
          // One mutation attempt only; a lost acknowledgement is reconciled by observation.
          try {
            await api("stop", { id });
          } catch {}
          await io.step("expiry_cleanup_stop", async () => {
            await observe(async (status) => {
              if (physicalStop(status)) return true;
              if (status.status !== "failed") return false;
              // The shipped terminal-failure status projection hides provider state.
              // Its durable stoppedAt is published only after physical exit confirmation.
              const row = await metadata();
              return (
                row.status === "failed" &&
                typeof row.stoppedAt === "string" &&
                Number.isFinite(Date.parse(row.stoppedAt))
              );
            }, 120);
            stopped = true;
          });
        } catch {
          passed = false;
        }
      });
    }
    const unknown = attempted && !id;
    io.out(
      JSON.stringify({
        step: "expiry_cleanup_summary",
        pass: stopped && !unknown,
        elapsedMs: io.now() - startedAt,
        leftoverSandboxIds: id && !stopped ? [id] : [],
        launchOutcomeUnknown: unknown,
        ...(unknown ? { org: item.org, golden: item.golden, startedAt } : {}),
      }),
    );
    if (!stopped || unknown) passed = false;
  }
  return passed;
}
