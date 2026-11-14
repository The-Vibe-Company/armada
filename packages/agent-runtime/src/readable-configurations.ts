import { type Harness, validateReadableVariables } from "@armada/core";
import type { Driver } from "./protocol.ts";

/** Native readable bootstrap is immutable per harness; identical delivery is idempotent. */
export class ReadableConfigurations {
  private readonly digests = new Map<Harness, string>();

  constructor(private readonly drivers: Partial<Record<Harness, Driver>>) {}

  configure(harness: Harness, value: unknown): void {
    const variables = validateReadableVariables(value);
    const digest = JSON.stringify(Object.entries(variables).sort());
    const previous = this.digests.get(harness);
    if (previous !== undefined && previous !== digest) throw Error("invalid_request");
    if (previous === digest) return;
    const bootstrap = this.drivers[harness]?.configureReadableVariables;
    if (!bootstrap) throw Error("invalid_request");
    bootstrap.call(this.drivers[harness], variables);
    this.digests.set(harness, digest);
  }
}
