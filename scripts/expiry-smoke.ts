export class ExpirySmokeFailure extends Error {
  constructor(readonly code: "invalid_receipt" | "expiry_not_stopped" | "poll_limit_exceeded") {
    super(code);
  }
}
interface Case {
  org: string;
  golden: string;
  provider: string;
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
const TTL = 180;
/** Observe the ordinary TTL lane; a manual cleanup stop can never count as expiry proof. */
export async function runExpiryCase(item: Case, io: Io): Promise<boolean> {
  const startedAt = io.now();
  let id: string | undefined;
  let attempted = false;
  let stopped = false;
  let passed = true;
  const api = <T>(action: string, body: object) => io.request<T>(`sandbox/${action}`, { org: item.org, ...body });
  const physicalStop = (status: Status) =>
    status.status === "stopped" && status.providerState === (item.provider === "boat" ? "archived" : "stopped");
  async function observe(done: (status: Status) => boolean, polls: number): Promise<Status> {
    for (let i = 0; i < polls; i++) {
      const status = await api<Status>("status", { id });
      if (status?.id !== id) throw new ExpirySmokeFailure("invalid_receipt");
      if (done(status)) return status;
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
      const result = await api<{ sandbox: { id: string; provider: string }; promptId?: string }>("launch", {
        golden: item.golden,
        provider: item.provider,
        harness: item.harness,
        model: item.model,
        credentialId: item.modelAccountId,
        ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
        connections: [],
        skipSkillDefaults: true,
        ttlSeconds: TTL,
      });
      if (typeof result?.sandbox?.id === "string" && result.sandbox.id) id = result.sandbox.id;
      if (!id || result.sandbox.provider !== item.provider || result.promptId)
        throw new ExpirySmokeFailure("invalid_receipt");
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
    await io.step("expiry_deadline", async () => {
      // Receipt must be a short ordinary TTL, not a hard-provider-timeout or an unbounded wait.
      const row = await metadata();
      const deadline = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
      if (
        row.effectiveTtlSeconds !== TTL ||
        row.expiresAt !== expiresAt ||
        !Number.isFinite(deadline) ||
        deadline <= startedAt ||
        deadline > io.now() + TTL * 1000 + 10_000
      )
        throw new ExpirySmokeFailure("invalid_receipt");
    });
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
      stopped = true;
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
            await observe(physicalStop, 120);
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
