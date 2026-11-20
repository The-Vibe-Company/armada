import { createHmac, timingSafeEqual } from "node:crypto";
import { BodyTooLargeError, createDeviceLoginStore, createDeviceOAuth } from "@armada/auth";
import type { Sql } from "@armada/core";
import { controlRouteKey, deviceConsentMessage, publicAuthOperations } from "@armada/core/contract";
import { decryptSecret, encryptSecret, VaultError } from "@armada/core/server";
import { authenticateCaller } from "./caller.ts";
import { readBody } from "./control-body.ts";
import type { ControlOptions } from "./control-options.ts";
import { fail } from "./control-response.ts";
import { defineRoutes } from "./routes.ts";

export function deviceLoginFromConfig(db: Sql, dashboardUrl: string, env: Record<string, string | undefined>) {
  const {
    ARMADA_CLI_OAUTH_CLIENT_ID: clientId,
    ARMADA_CLI_OAUTH_CLIENT_SECRET: clientSecret,
    ARMADA_CLI_CONSENT_KEY: consentKey,
  } = env;
  if (!clientId || !clientSecret || !consentKey || !/^[a-f0-9]{64}$/.test(consentKey)) return undefined;
  return {
    store: createDeviceLoginStore(db),
    dashboardUrl,
    consentKey,
    oauth: createDeviceOAuth(clientId, clientSecret, new URL("/cli-login", dashboardUrl).href),
  };
}

const { authDeviceStart, authDeviceInspect, authDeviceDecide, authDevicePoll } = publicAuthOperations;

async function handle(
  operation: typeof authDeviceStart | typeof authDeviceInspect | typeof authDeviceDecide | typeof authDevicePoll,
  request: Request,
  options: ControlOptions,
) {
  try {
    const body = await readBody(request);
    const device = options.deviceLogin;
    if (!device) return fail(503, "unavailable", "CLI sign-in is unavailable.");
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
      const code = await decryptSecret(result.codeEnc, options.encryptionKey);
      const session = await device.oauth(options.supabase, now).exchange(result.id, code, result.userId);
      return respond({ status: "authorized", ...session });
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

    const userId = caller.caller.userId;
    let codeEnc = null;
    if (approve) {
      const login = await device.store.inspect(id);
      if (login?.user_code !== user_code) return missing();
      const code = await device.oauth(options.supabase, now).approve(id, userId, authorization);
      codeEnc = await encryptSecret(code, options.encryptionKey);
    }
    const decided = await device.store.decide(id, user_code, userId, codeEnc);
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
