import { createHmac, timingSafeEqual } from "node:crypto";
import type { Route } from "./http.ts";

const maxBodyBytes = 256 * 1024;
const replayWindowMs = 5 * 60_000;
const hookPath = /^\/api\/v1\/hooks\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;

export type VerifiedDelivery = {
  triggerId: string;
  deliveryId: string;
  timestamp: number;
  revision: number;
  body: string;
};

export type TriggerAdmission =
  | { status: "unauthorized" }
  | { status: "rate_limited"; retryAfter: number }
  | { status: "queued" | "duplicate"; jobId: string };

export interface InboundTriggerStore {
  signingKey(triggerId: string): Promise<{ key: Uint8Array; revision: number } | undefined>;
  admit(delivery: VerifiedDelivery): Promise<TriggerAdmission>;
}

export function freshTriggerTimestamp(timestamp: number, now: number) {
  return Math.abs(now - timestamp) <= replayWindowMs;
}

async function readBody(request: Request) {
  if (Number(request.headers.get("content-length")) > maxBodyBytes) return;
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxBodyBytes) {
        void reader.cancel().catch(() => {});
        return;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });

export function inboundTriggerRoute(store: InboundTriggerStore, now = Date.now) {
  const route: Route = async (request) => {
    const path = new URL(request.url).pathname;
    const triggerId = hookPath.exec(path)?.[1];
    if (!triggerId || request.method !== "POST") return null;

    const encoding = request.headers.get("content-encoding");
    if (encoding !== null && encoding.toLowerCase() !== "identity") {
      return Response.json({ error: "unsupported_content_encoding" }, { status: 415 });
    }
    const body = await readBody(request);
    if (!body) return Response.json({ error: "payload_too_large" }, { status: 413 });

    const timestampHeader = request.headers.get("x-armada-timestamp") ?? "";
    const deliveryId = request.headers.get("x-armada-delivery-id") ?? "";
    const signature = request.headers.get("x-armada-signature") ?? "";
    if (
      !/^(0|[1-9][0-9]{0,12})$/.test(timestampHeader) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(deliveryId) ||
      !/^[0-9a-f]{64}$/.test(signature)
    )
      return unauthorized();

    const timestamp = Number(timestampHeader) * 1000;
    if (!freshTriggerTimestamp(timestamp, now())) return unauthorized();
    const signing = await store.signingKey(triggerId);
    if (!signing) return unauthorized();

    const digest = createHmac("sha256", signing.key)
      .update(`POST\n${path}\n${timestampHeader}\n${deliveryId}\n`)
      .update(body)
      .digest();
    if (!timingSafeEqual(digest, Buffer.from(signature, "hex"))) return unauthorized();

    let event: string;
    try {
      event = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    } catch {
      return Response.json({ error: "invalid_utf8" }, { status: 400 });
    }

    const result = await store.admit({ triggerId, deliveryId, timestamp, revision: signing.revision, body: event });
    if (result.status === "unauthorized") return unauthorized();
    if (result.status === "rate_limited") {
      return Response.json(
        { error: "rate_limited", retryAfter: result.retryAfter },
        {
          status: 429,
          headers: { "retry-after": String(result.retryAfter) },
        },
      );
    }
    return Response.json(
      { triggerId, deliveryId, jobId: result.jobId },
      {
        status: result.status === "queued" ? 202 : 200,
      },
    );
  };
  return route;
}
