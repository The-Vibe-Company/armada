import { createHash } from "node:crypto";
import type { Provider, ResumeStageObserver } from "@armada/core";
import { resolveModelChoice } from "@armada/core";
import { modalError, refusal } from "./errors.ts";
import type { createPhysicalLifecycle } from "./physical-lifecycle.ts";
import type { Machine, RunnerTransport } from "./ports.ts";
import type { ModalProvider, ModalProviderOptions } from "./provider.ts";

type NativeTurns = Required<Pick<Provider, "prompt" | "getPrompt" | "steer" | "interrupt" | "events" | "quiesce">>;

interface NativeLifecycleOptions {
  options: Pick<
    ModalProviderOptions,
    "store" | "distribution" | "storedReads" | "admissionSleep" | "beforeResume" | "resumeRefused" | "beforePrompt"
  >;
  provider(): ModalProvider;
  runner: RunnerTransport;
  measure: NonNullable<ModalProviderOptions["measure"]>;
  bound(): Promise<unknown>;
  assertMachineSource(row: Machine): void;
  physicalLifecycle: Pick<ReturnType<typeof createPhysicalLifecycle>, "create" | "physical">;
}

export function createNativeLifecycle({
  options,
  provider,
  runner,
  measure,
  bound,
  assertMachineSource,
  physicalLifecycle: { create, physical },
}: NativeLifecycleOptions) {
  const { store, distribution } = options;
  async function readyLeased(
    row: Machine,
    save: (row: Machine) => Promise<void>,
    onResumeStage?: ResumeStageObserver,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    assertMachineSource(row);
    if (row.golden && row.quiesced) throw refusal("sandbox_not_ready", "Sealed golden admission cannot be reopened.");
    if (row.phase === "stopped") {
      if (row.commonRuntime) throw refusal("invalid_request", "Enrolled Modal resume is not enabled.");
      if (!row.recoveryImageId) throw refusal("conflict", "Stopped sandbox has no durable recovery image.");
      await onResumeStage?.("accepted");
      signal?.throwIfAborted();
      await options.beforeResume?.(provider(), row.info.id);
      row.generation++;
      row.quiesced = false;
      delete row.ordinaryStopAttempted;
      delete row.info.stopNote;
      row.eventBase = row.checkpointWatermark ?? 0;
      row.imageId = row.recoveryImageId;
      row.physicalName = `armada-${createHash("sha256").update(row.info.id).digest("hex").slice(0, 32)}-${row.generation}`;
      row.phase = "reserved";
      row.info.state = "starting";
      delete row.physicalId;
      delete row.processBaseline;
      try {
        signal?.throwIfAborted();
        await save(row);
      } catch (error) {
        await options.resumeRefused?.(provider(), row.info.id);
        throw error;
      }
    }
    if (row.generation > 1 && ["reserved", "creating", "booting"].includes(row.phase)) {
      signal?.throwIfAborted();
      const env = await distribution.restoreEnv(row);
      signal?.throwIfAborted();
      await create(row, save, env, onResumeStage);
    }
    signal?.throwIfAborted();
    if (row.phase !== "active") throw refusal("sandbox_not_ready", "Sandbox lifecycle is not active.");
    if ((await (await physical(row)).poll()) !== null)
      throw refusal(
        "sandbox_not_ready",
        "Physical machine expired or exited; no verified checkpoint is available for current writes.",
      );
    return row;
  }
  async function ready(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const row = await store.get(id);
    signal?.throwIfAborted();
    if (row.phase === "stopped" || (row.generation > 1 && ["reserved", "creating", "booting"].includes(row.phase)))
      return store.lease(id, (leased, save) => readyLeased(leased, save, undefined, signal));
    return readyLeased(
      row,
      async () => {
        throw refusal("conflict", "Activation requires a lifecycle lease.");
      },
      undefined,
      signal,
    );
  }
  async function healthyAdmission(
    row: Machine,
    save: (row: Machine) => Promise<void>,
    onResumeStage?: ResumeStageObserver,
  ) {
    if (row.commonRuntime) throw refusal("invalid_request", "Enrolled runtime commands require the common transport.");
    const active = await readyLeased(row, save, onResumeStage);
    const health = await measure("modal_health", () =>
      runner.call<{ generation: string; ready: boolean }>(active, "health", {}),
    );
    if (!health || health.generation !== String(active.generation) || health.ready !== true)
      throw refusal("sandbox_not_ready", "Runner admission is not open for this generation.");
    return active;
  }
  async function admit<T>(id: string, work: (row: Machine, save: (row: Machine) => Promise<void>) => Promise<T>) {
    for (let attempt = 0; ; attempt++) {
      let entered = false;
      try {
        return await store.lease(id, (row, save) => {
          entered = true;
          return work(row, save);
        });
      } catch (error) {
        if (entered || modalError(error).providerCode !== "lifecycle_lease_busy" || attempt >= 99) throw error;
        if ((await store.get(id)).phase !== "active") throw error;
        await (options.admissionSleep ?? Bun.sleep)(20);
      }
    }
  }
  async function call<T>(id: string, op: string, input: object, signal?: AbortSignal) {
    const row = await ready(id, signal);
    signal?.throwIfAborted();
    if (row.commonRuntime) throw refusal("invalid_request", "Enrolled runtime commands require the common transport.");
    return runner.call<T>(row, op, input);
  }
  const turns: NativeTurns = {
    async prompt(r) {
      const incarnation = (row: Machine) =>
        JSON.stringify([
          row.generation,
          row.physicalId ?? null,
          row.grantExpiresAt ?? null,
          row.processBaseline?.namespace.pid ?? null,
          row.processBaseline?.namespace.mount ?? null,
        ]);
      let expected: string | undefined;
      let restored = false;
      const observeResume: ResumeStageObserver | undefined =
        r.onResumeStage &&
        (async (stage) => {
          if (stage === "machine_started") restored = true;
          await r.onResumeStage?.(stage);
        });
      if (options.beforePrompt) {
        expected = await measure("modal_prepare", () =>
          admit(r.sandboxId, async (row, save) => {
            if (row.golden) throw refusal("invalid_request", "Golden builders cannot run model turns.");
            return incarnation(await readyLeased(row, save, observeResume));
          }),
        );
        await measure("modal_before_prompt", () => options.beforePrompt!(provider(), r.sandboxId));
      }
      return measure("modal_admit", () =>
        admit(r.sandboxId, async (row, save) => {
          if (row.golden) throw refusal("invalid_request", "Golden builders cannot run model turns.");
          if (expected !== undefined && (row.phase !== "active" || incarnation(row) !== expected))
            throw refusal(
              "conflict",
              "Prompt preparation belongs to a different physical incarnation; turn not submitted.",
            );
          const active = await healthyAdmission(row, save, observeResume);
          if (expected !== undefined && (active.phase !== "active" || incarnation(active) !== expected))
            throw refusal("conflict", "Runner incarnation changed during admission; turn not submitted.");
          const choice = resolveModelChoice(r.harness, r, active.modelDefaults?.[r.harness]);
          const cwd = active.harnessCwds?.[r.harness];
          if (restored) await r.onResumeStage?.("harness_ready");
          return measure("modal_rpc", () =>
            runner.call(active, "prompt", {
              input: {
                sandboxId: r.sandboxId,
                harness: r.harness,
                text: r.text,
                ...choice,
                ...(r.conversationId !== undefined ? { conversationId: r.conversationId } : {}),
                ...(r.fast !== undefined ? { fast: r.fast } : {}),
                ...(cwd !== undefined ? { cwd } : {}),
              },
            }),
          );
        }),
      );
    },
    async getPrompt(r) {
      const row = await store.get(r.sandboxId);
      assertMachineSource(row);
      if (row.commonRuntime)
        throw refusal("invalid_request", "Enrolled runtime history requires the common transport.");
      if (row.phase === "active" && !options.storedReads) return runner.call(row, "getPrompt", r);
      if (options.storedReads) {
        if (row.phase === "deleted") throw refusal("not_found", "Sandbox was deleted.");
        const latest = await store.latestPrompt(r.sandboxId, r.promptId);
        if (!latest) {
          if (row.phase === "active") return { promptId: r.promptId, status: "queued", done: false };
          throw refusal("not_found", "No durable prompt observation found.");
        }
        return {
          promptId: r.promptId,
          ...(latest.conversationId ? { conversationId: latest.conversationId } : {}),
          status: latest.status,
          done: !["queued", "running"].includes(latest.status),
        };
      }
      let cursor: string | undefined;
      let latest: import("@armada/core").AgentEvent | undefined;
      for (;;) {
        const page = await store.events({ sandboxId: r.sandboxId, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const event of page.events) if (event.kind === "prompt" && event.promptId === r.promptId) latest = event;
        if (!page.hasMore) break;
        if (!page.cursor || page.cursor === cursor)
          throw refusal("unavailable", "Prompt event cursor did not advance.");
        cursor = page.cursor;
      }
      if (latest?.kind !== "prompt") throw refusal("not_found", "No durable prompt observation found.");
      return {
        promptId: r.promptId,
        ...(latest.conversationId ? { conversationId: latest.conversationId } : {}),
        status: latest.status,
        done: !["queued", "running"].includes(latest.status),
      };
    },
    steer(r) {
      return admit(r.sandboxId, async (row, save) => {
        if (row.golden) throw refusal("invalid_request", "Golden builders cannot run model turns.");
        if (row.phase === "stopped") throw refusal("sandbox_not_ready", "Stopped sandboxes cannot be steered.");
        return runner.call(await healthyAdmission(row, save), "steer", {
          sandboxId: r.sandboxId,
          conversationId: r.conversationId,
          text: r.text,
        });
      });
    },
    interrupt: (r) => call(r.sandboxId, "interrupt", r),
    async events(r) {
      r.signal?.throwIfAborted();
      if (!options.storedReads) await bound();
      r.signal?.throwIfAborted();
      const row = await store.get(r.sandboxId);
      if (row.commonRuntime)
        throw refusal("invalid_request", "Enrolled runtime history requires the common transport.");
      assertMachineSource(row);
      if (row.phase === "deleted") throw refusal("not_found", "Sandbox was deleted.");
      r.signal?.throwIfAborted();
      const page = await store.events(r);
      r.signal?.throwIfAborted();
      return page;
    },
    quiesce: (r) => call(r.sandboxId, "interrupt", r),
  };
  return { ready, healthyAdmission, admit, call, turns };
}
