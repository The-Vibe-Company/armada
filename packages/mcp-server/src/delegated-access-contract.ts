export class DelegatedAccessError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "unavailable" | "invalid_request") {
    super(code);
  }
}
export interface DelegatedAccessTransport {
  readonly physicalGeneration: string;
  readonly lifecycleGeneration: string;
  deliver(token: string, binding: { epoch: string; physicalGeneration: string }): Promise<{ acknowledged: boolean }>;
  scrub(tokenHash?: string): Promise<void>;
}
