import { createHmac, timingSafeEqual } from "node:crypto";
import { BodyTooLargeError, createDeviceLoginStore, createDeviceSession } from "@armada/auth";
import type { Sql } from "@armada/core";
import { controlRouteKey, deviceConsentMessage, publicAuthOperations } from "@armada/core/contract";
import { VaultError } from "@armada/core/server";
import { authenticateCaller } from "./caller.ts";
import { readBody } from "./control-body.ts";
import type { ControlOptions } from "./control-options.ts";
import { fail } from "./control-response.ts";
import { defineRoutes } from "./routes.ts";

export function deviceLoginFromConfig(
  db: Sql,
  dashboardUrl: string,
  adminKey: string | undefined,
  consentKey: string | undefined,
) {
  if (!adminKey || !consentKey || !/^[a-f0-9]{64}$/.test(consentKey)) return undefined;
  return { store: createDeviceLoginStore(db), dashboardUrl, adminKey, consentKey };
}

const { authDeviceStart, authDeviceInspect, authDeviceDecide, authDevicePoll } = publicAuthOperations;

async function handle(
  operation: typeof authDeviceStart | typeof authDeviceInspect | typeof authDeviceDecide | typeof authDevicePoll,
  request: Request,
  options: ControlOptions,
) {
  const device = options.deviceLogin;
  if (!device) return fail(503, "unavailable", "CLI sign-in is unavailable.");
  try {
    const body = await readBody(request);
    const now = options.now?.() ?? new Date();
    const respond = (value: unknown) => Response.json(value, { headers: { "cache-control": "no-store" } });

    if (operation === authDeviceStart) {
      const parsed = authDeviceStart.input.body.safeParse(body);
      if (!parsed.success) return fail(400, "invalid", "Invalid CLI login request.");
      const login = await device.store.start(parsed.data.hostname);
      if (!login) return fail(429, "rate_limited", "Too many CLI login requests. Try again in a minute.");
      const url = new URL("/cli-login", device.dashboardUrl);
      url.searchParams.set("id", login.id);
      return respond({
        device_code: login.deviceCode,
        user_code: login.userCode,
        verification_uri_complete: url.toString(),
        expires_in: login.expiresIn,
        interval: login.interval,
      });
    }

    if (operation === authDevicePoll) {
      const parsed = authDevicePoll.input.body.safeParse(body);
      if (!parsed.success) return fail(400, "invalid", "Invalid CLI poll.");
      const result = await device.store.poll(parsed.data.device_code);
      if (result.status !== "approved") return respond(result);
      const { accessToken, refreshToken, expiresAt, email } = await createDeviceSession(
        { ...options.supabase, fetch: options.supabase.fetch ?? fetch, adminKey: device.adminKey, now },
        result.userId,
      );
      return respond({ status: "authorized", accessToken, refreshToken, expiresAt, email });
    }

    const authorization = request.headers.get("authorization");
    const caller = await authenticateCaller(authorization, {
      store: options.authStore,
      supabase: options.supabase,
      now,
    });
    if (!authorization || !caller.ok || caller.caller.via !== "supabase")
      return fail(401, "unauthorized", "Sign in on the dashboard to continue.");

    const missing = () => fail(404, "not_found", "This CLI login request is no longer available.");
    if (operation === authDeviceInspect) {
      const parsed = authDeviceInspect.input.body.safeParse(body);
      if (!parsed.success) return fail(400, "invalid", "Invalid CLI login request.");
      const login = await device.store.inspect(parsed.data.id);
      return login ? respond(login) : missing();
    }

    const parsed = authDeviceDecide.input.body.safeParse(body);
    if (!parsed.success) return fail(400, "invalid", "Invalid CLI login decision.");
    const { id, user_code, approve, issued_at, proof } = parsed.data;
    const expected = createHmac("sha256", device.consentKey)
      .update(deviceConsentMessage(parsed.data, caller.caller.userId, authorization))
      .digest();
    if (Math.abs(now.getTime() - issued_at) > 60_000 || !timingSafeEqual(expected, Buffer.from(proof, "hex")))
      return fail(401, "unauthorized", "Confirm the CLI login on the dashboard.");

    const decided = await device.store.decide(id, user_code, caller.caller.userId, approve);
    return decided ? respond({ ok: true }) : missing();
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", "CLI login request is too large.");
    if (error instanceof VaultError) return fail(400, "invalid", "Invalid CLI login request.");
    return fail(503, "unavailable", "CLI sign-in could not complete. Start a new login.");
  }
}

export const deviceLoginRoutes = defineRoutes(
  "device-login",
  Object.fromEntries(
    [authDeviceStart, authDeviceInspect, authDeviceDecide, authDevicePoll].map((operation) => [
      controlRouteKey(operation.route),
      {
        methods: [operation.route.method],
        respond: (request: Request, options: ControlOptions) => handle(operation, request, options),
      },
    ]),
  ),
);
