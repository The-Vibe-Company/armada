import type { Provider } from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { observeProvider } from "./request-observability.ts";

export function createObservedBoatProvider(options: Parameters<typeof createBoatProvider>[0], sandboxId?: string) {
  return observeProvider("boat", createBoatProvider(options), { sandboxId: () => sandboxId });
}

export function withBoatManagementIdentity(provider: Provider, scope: "org" | "user", ownerId: string) {
  const authority = Object.freeze({ scope, ownerId });
  return new Proxy(provider, {
    get(instance, property) {
      if (property === "managementIdentity") return async () => authority;
      const value = Reflect.get(instance, property, instance);
      return typeof value === "function" ? value.bind(instance) : value;
    },
    set(instance, property, value) {
      return property !== "managementIdentity" && Reflect.set(instance, property, value, instance);
    },
  });
}
