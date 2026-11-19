import { isHarness } from "@armada/core";
import { isUuid } from "./action.ts";
import { type ArmadaApiOptions, ControlError, controlResource } from "./control.ts";

function record(value: unknown) {
  if (typeof value !== "object" || !value || Array.isArray(value)) return {} as Record<string, unknown>;
  return value as Record<string, unknown>;
}

const unexpected = () => new ControlError("The Armada server sent an unexpected inbound trigger response.");

function count(value: unknown, minimum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw unexpected();
  return value;
}

function parseTrigger(value: unknown) {
  const { id, templateId, poolHarness, enabled, ratePerMinute, concurrency, rateRefusals } = record(value);
  if (
    !isUuid(id) ||
    (templateId !== null && !isUuid(templateId)) ||
    !isHarness(poolHarness) ||
    typeof enabled !== "boolean"
  )
    throw unexpected();
  return {
    id,
    templateId,
    poolHarness,
    enabled,
    ratePerMinute: count(ratePerMinute, 1),
    concurrency: count(concurrency, 1),
    rateRefusals: count(rateRefusals, 0),
  };
}

const processingLabels = { queued: "Queued", leased: "Processing", done: "Processed", failed: "Failed" } as const;

function parseDelivery(value: unknown) {
  const { deliveryId, receivedAt, jobState } = record(value);
  if (
    typeof deliveryId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(deliveryId) ||
    typeof receivedAt !== "string" ||
    !Number.isFinite(Date.parse(receivedAt)) ||
    typeof jobState !== "string" ||
    !Object.hasOwn(processingLabels, jobState)
  )
    throw unexpected();
  return { deliveryId, receivedAt, processingState: processingLabels[jobState as keyof typeof processingLabels] };
}

function array(value: unknown) {
  if (!Array.isArray(value)) throw unexpected();
  return value as unknown[];
}

export function createInboundTriggerControl(options: ArmadaApiOptions, org: string) {
  function request(method: "GET" | "POST", suffix = "") {
    return controlResource(options, `/api/v1/triggers${suffix}?org=${encodeURIComponent(org)}`, method);
  }
  return {
    async list() {
      return array(record(await request("GET")).triggers).map(parseTrigger);
    },
    async deliveries(id: string) {
      return array(record(await request("GET", `/${encodeURIComponent(id)}/deliveries`)).deliveries).map(parseDelivery);
    },
    async rotate(id: string) {
      const { signingSecret } = record(await request("POST", `/${encodeURIComponent(id)}/rotate`));
      if (typeof signingSecret !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(signingSecret)) throw unexpected();
      return signingSecret;
    },
    async disable(id: string) {
      await request("POST", `/${encodeURIComponent(id)}/disable`);
    },
  };
}
