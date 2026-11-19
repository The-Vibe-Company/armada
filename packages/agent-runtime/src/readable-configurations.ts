import { type Harness, validateReadableVariables } from "@armada/core";
import type { Journal } from "./journal.ts";
import type { Driver } from "./protocol.ts";

/** Native readable bootstrap is immutable per harness; identical delivery is idempotent. */
export class ReadableConfigurations {
  private readonly digests = new Map<Harness, string>();

  constructor(
    private readonly drivers: Partial<Record<Harness, Driver>>,
    private readonly journal: Journal,
  ) {}

  configure(harness: Harness, value: unknown, secretKeys: unknown): void {
    const variables = validateReadableVariables(value);
    const keys = secretKeys === undefined ? [] : secretKeys;
    if (
      !Array.isArray(keys) ||
      keys.length > Object.keys(variables).length ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => typeof key !== "string" || !Object.hasOwn(variables, key))
    )
      throw Error("invalid_request");
    const digest = JSON.stringify([Object.entries(variables).sort(), [...keys].sort()]);
    const previous = this.digests.get(harness);
    if (previous !== undefined && previous !== digest) throw Error("invalid_request");
    if (previous === digest) return;
    const bootstrap = this.drivers[harness]?.configureReadableVariables;
    if (!bootstrap) throw Error("invalid_request");
    this.journal.registerApplicationSecrets(keys.map((key) => variables[key]!));
    bootstrap.call(this.drivers[harness], variables);
    this.digests.set(harness, digest);
  }
}
