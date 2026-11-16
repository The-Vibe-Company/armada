import { expect, test } from "bun:test";
import type { Provider } from "@armada/core";
import type { SandboxView, ServerSandboxStore } from "../src/data.ts";
import { collectSandboxUsage } from "../src/turns.ts";

test.each(["archived", "unobservable"])(
  "usage fan-out observes %s compute once and persists diagnostics without guest exec",
  async (state) => {
    let reads = 0;
    let captures = 0;
    let saved: unknown;
    const sandbox = {
      id: "sandbox",
      providerSandboxId: "provider_fixture",
      harness: "codex",
      usage: null,
    } as SandboxView;
    const provider = {
      id: "boat",
      async get() {
        reads++;
        if (state === "unobservable") throw Error("provider state unavailable");
        return { state: "stopped", providerState: "archived" };
      },
      async events() {
        return {
          events: Array.from({ length: 20 }, (_, n) => ({
            id: `e${n}`,
            kind: "prompt",
            promptId: `p${n}`,
            at: n,
            status: "completed",
          })),
          hasMore: false,
        };
      },
      async collectTurnUsage() {
        captures++;
        throw Error("terminal guest must not be read");
      },
    } as unknown as Provider;
    const store = {
      async get() {
        return sandbox;
      },
      async recordUsage(_id: string, usage: unknown) {
        saved = usage;
      },
    } as unknown as ServerSandboxStore;
    await collectSandboxUsage(provider, store, sandbox);
    expect(reads).toBe(1);
    expect(captures).toBe(0);
    expect(saved).toMatchObject({
      turnCount: 20,
      turns: Array.from({ length: 20 }, (_, n) => ({
        promptId: `p${n}`,
        unavailableReason: { code: state === "archived" ? "compute_inactive" : "reader_unavailable" },
      })),
    });
  },
);
