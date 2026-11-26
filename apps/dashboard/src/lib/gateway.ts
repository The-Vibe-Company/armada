import { isRecord } from "@armada/core";
import { type RelayTicketRequest, relayTicketResponse } from "@armada/core/contract";
import { ControlError, type createControlClient } from "./control.ts";
import { describeFailure } from "./failure.ts";
import type { SendArgs } from "./model-choice.ts";

export class GatewayError extends Error {
  override readonly name = "GatewayError";
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sandboxGateway(control: ReturnType<typeof createControlClient>) {
  async function post<T = unknown>(route: string, body: Record<string, unknown>): Promise<T> {
    let result: unknown;
    try {
      result = await control.post<T>(route, body);
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      throw new GatewayError(describeFailure(error.code)?.hint ?? error.message, error.status, error.code);
    }
    if (!isRecord(result)) throw new GatewayError("The Armada server sent something unreadable.");
    return result as T;
  }

  return {
    logs: (
      sandboxId: string,
      since?: string | null,
      read: { all?: true; limit?: number; direction?: "forward" | "backward"; coalesce?: boolean } = {},
    ) => post("logs/read", { id: sandboxId, ...(since ? { cursor: since } : {}), ...read }),
    status: (sandboxId: string, promptId?: string) =>
      post("sandbox/status", { id: sandboxId, ...(promptId ? { prompt_id: promptId } : {}) }),
    stop: (sandboxId: string) => post("sandbox/stop", { id: sandboxId }),
    async delete(sandboxId: string) {
      const receipt = await control.deleteSandbox(sandboxId);
      if (!isRecord(receipt) || receipt.id !== sandboxId.toLowerCase() || receipt.status !== "deleted") {
        throw new ControlError("The delete request could not be confirmed.", undefined, undefined, {
          outcomeUnknown: true,
        });
      }
    },
    async extend(sandboxId: string, ttlSeconds: number) {
      const receipt = await control.post("sandbox/extend", { id: sandboxId, ttlSeconds });
      if (
        !isRecord(receipt) ||
        receipt.id !== sandboxId.toLowerCase() ||
        typeof receipt.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(receipt.expiresAt)) ||
        receipt.ttlSeconds !== ttlSeconds
      ) {
        throw new ControlError(
          "The extension could not be confirmed. Reload the sandbox to check its deadline before trying again.",
          undefined,
          undefined,
          { outcomeUnknown: true },
        );
      }
    },
    send: (sandboxId: string, prompt: string, override: SendArgs = {}, requestId?: string) =>
      post("sandbox/send", {
        id: sandboxId,
        prompt,
        ...override,
        ...(requestId ? { request_id: requestId } : {}),
      }),
    steer: (sandboxId: string, text: string) => post("sandbox/steer", { id: sandboxId, text }),
    interrupt: (sandboxId: string) => post("sandbox/interrupt", { id: sandboxId }),
    exec: (sandboxId: string, command: string, timeoutSeconds?: number) =>
      post("sandbox/exec", {
        id: sandboxId,
        command,
        ...(timeoutSeconds === undefined ? {} : { timeout_seconds: timeoutSeconds }),
      }),
    async relayTicket(sandboxId: string, input: RelayTicketRequest) {
      const parsed = relayTicketResponse.safeParse(
        await post(`sandboxes/${encodeURIComponent(sandboxId)}/relay-ticket`, input),
      );
      if (!parsed.success) throw new GatewayError("The Armada server sent an unreadable relay ticket.");
      return parsed.data;
    },
  };
}
