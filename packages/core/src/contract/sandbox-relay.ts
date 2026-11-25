import { z } from "zod";
import type { Operation } from "./index.ts";

export const RELAY_MODES = ["pty", "tcp", "preview"] as const;
export type RelayMode = (typeof RELAY_MODES)[number];
export const RELAY_TICKET_ERRORS = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "sandbox_not_ready",
  "unsupported",
  "rate_limited",
  "relay_unavailable",
] as const;
export type RelayTicketErrorCode = (typeof RELAY_TICKET_ERRORS)[number];
const noNul = (v: string) => !v.includes("\0");

export const relayTicketRequest = z
  .strictObject({
    mode: z.enum(RELAY_MODES),
    port: z.number().int().min(1).max(65_535).optional(),
    cwd: z.string().min(1).max(4096).refine(noNul, "cwd must not contain NUL bytes.").optional(),
    org: z.string().trim().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    const add = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (v.mode === "preview" && v.port === undefined) add("port", "port is required for preview mode.");
    if (v.mode === "pty" && v.port !== undefined) add("port", "port is not allowed for pty mode.");
    if (v.mode !== "pty" && v.cwd !== undefined) add("cwd", "cwd is only allowed for pty mode.");
  });

export const relayTicketResponse = z.strictObject({
  ticket: z.string().min(1),
  wsUrl: z.url({ protocol: /^wss?$/ }),
  bootstrapUrl: z.url({ protocol: /^https?$/ }).optional(),
  previewUrl: z.url({ protocol: /^https?$/ }).optional(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type RelayTicketRequest = z.infer<typeof relayTicketRequest>;
export type RelayTicketResponse = z.infer<typeof relayTicketResponse>;

export const sandboxRelayOperations = {
  mintTicket: {
    name: "mintSandboxRelayTicket",
    directServer: true,
    route: { method: "POST", path: "/api/v1/sandboxes/{id}/relay-ticket" },
    input: { body: relayTicketRequest, path: { id: z.uuid() }, maxBodyBytes: 4096, oversizedBodyStatus: 400 },
    output: relayTicketResponse,
    errorOutput: z.strictObject({
      error: z.strictObject({ code: z.enum(RELAY_TICKET_ERRORS), message: z.string().min(1) }),
    }),
    successHeaders: { "Cache-Control": z.literal("no-store") },
    readOnly: false,
    destructive: false,
    audience: "public",
    description: "Mint a short-lived relay ticket for PTY, loopback TCP forwarding, or HTTP preview.",
    errors: RELAY_TICKET_ERRORS,
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType>>;
