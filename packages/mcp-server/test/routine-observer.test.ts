import { expect, test } from "bun:test";
import { observeRoutinePrompt } from "../src/routine-observer.ts";

// Transport owner: Docker retained prompt state must never fall through to a golden provider.
test("routine observation uses the exact Docker prompt and retains unknown when its state is missing", async () => {
  const caller = { userId: "owner", orgs: [], via: "service" as const };
  const turn = { sandboxId: "sandbox", promptId: "scheduled-prompt", conversationId: "conversation" };
  let state: string | null = "finished";
  const ports = {
    docker: {
      invoke: async (received: typeof caller, name: string, args: Record<string, unknown>) => {
        expect(received).toBe(caller);
        expect(name).toBe("status");
        expect(args).toEqual({ id: "sandbox", prompt_id: "scheduled-prompt" });
        return { handled: true as const, result: { prompt: state ? { state } : null } };
      },
    },
    get: async () => {
      throw Error("Docker must not use the golden sandbox store");
    },
    provider: async () => {
      throw Error("Docker must not resolve a golden provider");
    },
  };
  expect(await observeRoutinePrompt(caller, turn, ports)).toBe("finished");
  state = null;
  expect(await observeRoutinePrompt(caller, turn, ports)).toBe("unknown");
});
