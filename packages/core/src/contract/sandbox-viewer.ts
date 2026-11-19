import { z } from "zod";
import type { Operation } from "./index.ts";
import { sandboxOperations } from "./sandbox.ts";
import { readLogsOperation } from "./sandbox-reads.ts";

const cursor = z
  .string()
  .max(262144)
  .regex(/^[^\r\n]*$/)
  .nullish();
const pageInput = z.object({ cursor });
const viewerAccessErrors = ["viewer_access_denied"] as const;

export const sandboxViewerOperations = {
  mint: {
    name: "createSandboxViewerToken",
    route: { method: "POST", path: "/api/v1/sandbox/viewer-token" },
    input: { body: z.object({ id: z.string().regex(/^[0-9a-f-]{36}$/i) }) },
    output: z.object({ token: z.string(), expiresAt: z.iso.datetime() }),
    readOnly: false,
    destructive: false,
    audience: "public",
    description: "Issue a short-lived viewer grant for one sandbox visible to a service credential.",
    errors: viewerAccessErrors,
  },
  logs: {
    name: "readViewerLogs",
    route: { method: "POST", path: "/api/v1/viewer/logs" },
    input: { body: pageInput },
    output: readLogsOperation.output,
    readOnly: true,
    destructive: false,
    audience: "public",
    description: "Read a log page for the sandbox bound to the viewer grant.",
    errors: [...viewerAccessErrors, ...readLogsOperation.errors],
  },
  status: {
    name: "readViewerStatus",
    route: { method: "POST", path: "/api/v1/viewer/status" },
    input: { body: pageInput },
    output: sandboxOperations.sandboxStatus.output,
    readOnly: true,
    destructive: false,
    audience: "public",
    description: "Read status for the sandbox bound to the viewer grant.",
    errors: [...viewerAccessErrors, ...sandboxOperations.sandboxStatus.errors],
  },
  send: {
    name: "sendViewerPrompt",
    route: { method: "POST", path: "/api/v1/viewer/send" },
    input: {
      body: pageInput.extend({
        message: z.string().regex(/\S/),
        requestId: z.string().optional().catch(undefined),
      }),
    },
    output: sandboxOperations.sendPrompt.output,
    readOnly: false,
    destructive: false,
    audience: "public",
    description: "Send a prompt to the sandbox bound to the viewer grant.",
    errors: [...viewerAccessErrors, ...sandboxOperations.sendPrompt.errors],
  },
  events: {
    name: "streamViewerEvents",
    route: { method: "GET", path: "/api/v1/viewer/events" },
    input: { body: z.object({}), query: pageInput },
    output: z.discriminatedUnion("event", [
      z.object({ event: z.literal("page"), data: readLogsOperation.output }),
      z.object({ event: z.literal("access-ended"), data: z.strictObject({}) }),
    ]),
    outputMediaType: "text/event-stream",
    readOnly: true,
    destructive: false,
    audience: "public",
    description: "Stream log pages for a viewer grant. Resume with the cursor query parameter or Last-Event-ID.",
    errors: [...viewerAccessErrors, ...readLogsOperation.errors],
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType>>;
