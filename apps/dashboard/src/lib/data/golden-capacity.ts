import { createBoatProvider } from "@armada/provider-boat";

/**
 * Server-only. The number of goldens one Boat account holds, read from the Boat provider adapter's own
 * `maxGoldens` (the value the server's golden builder reserves against). The probe holds no key and its
 * fetch refuses every request, so this makes no network call; only the resulting number reaches a page.
 * Never import this from a client component: the adapter and its SDK stay out of the browser bundle.
 */
const refuse = (): Promise<Response> => Promise.reject(new Error("The capacity probe makes no requests."));

export function boatGoldenCapacity(): number | null {
  const probe = createBoatProvider({
    apiKey: "",
    fetch: Object.assign(refuse, { preconnect: () => {} }),
  });
  const capacity = probe.maxGoldens;
  return typeof capacity === "number" && Number.isInteger(capacity) && capacity > 0 ? capacity : null;
}
