import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AuthIo } from "../src/auth-commands.ts";
import { emailLogin } from "../src/email-login.ts";
import { memorySessionStore } from "../src/session.ts";

const session = { accessToken: "access", refreshToken: "refresh", expiresAt: "2099-01-01" };

for (const completion of ["link", "code"] as const) {
  test(`email ${completion} completion uses PKCE and cleans up both inputs`, async () => {
    let handler!: (request: Request) => Promise<Response>;
    let stops = 0;
    const listener = spyOn(Bun, "serve").mockImplementation((options) => {
      handler = (options as unknown as { fetch: typeof handler }).fetch;
      return {
        port: 43123,
        stop: async () => {
          stops++;
        },
      } as never;
    });
    let start: { redirect_uri: string; state: string; code_challenge: string; cli_email_link: boolean };
    let aborted = false;
    let exchanges = 0;
    const io: AuthIo = {
      env: {},
      out: () => undefined,
      err: () => undefined,
      now: () => new Date(0),
      open: () => undefined,
      session: memorySessionStore(),
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/email/start")) {
          start = JSON.parse(String(init?.body));
          return Response.json({});
        }
        if (path.endsWith("/exchange")) {
          exchanges++;
          const body = JSON.parse(String(init?.body));
          expect(body.code).toBe("authorization-code");
          expect(createHash("sha256").update(body.verifier).digest("base64url")).toBe(start.code_challenge);
          return completion === "link"
            ? Response.json({ ...session, armadaUrl: "https://untrusted.example", unexpected: "ignored" })
            : Response.json(
                { error: { code: "unavailable", message: "Sign-in service is unavailable. Try again later." } },
                { status: 503 },
              );
        }
        expect(path).toBe("/api/v1/auth/email/verify");
        expect(JSON.parse(String(init?.body))).toEqual({ email: "user@example.test", code: "123456" });
        return Response.json({ ...session, armadaUrl: "https://untrusted.example", unexpected: "ignored" });
      },
      readCode: async (signal) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        expect(start.cli_email_link).toBe(true);
        expect(new URL(start.redirect_uri).pathname).toBe("/callback");
        expect((await handler(new Request(`${start.redirect_uri}?state=wrong&code=wrong`))).status).toBe(400);
        expect(
          (await handler(new Request(`${start.redirect_uri}?state=${start.state}&access_token=never-accepted`))).status,
        ).toBe(400);
        if (completion === "link") {
          const callback = new URL(start.redirect_uri);
          callback.searchParams.set("state", start.state);
          callback.searchParams.set("code", "authorization-code");
          expect((await handler(new Request(callback.toString()))).status).toBe(200);
          return new Promise<string>((_, reject) =>
            signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }),
          );
        }
        const refused = new URL(start.redirect_uri);
        refused.searchParams.set("state", start.state);
        refused.searchParams.set("code", "authorization-code");
        const unavailable = await handler(new Request(refused.toString()));
        expect(unavailable.status).toBe(503);
        expect(await unavailable.text()).toBe("Sign-in service is unavailable. Try again later.");
        return "123456";
      },
    };
    try {
      expect(await emailLogin(io, "user@example.test", "https://armada.example")).toEqual(session);
      expect(aborted).toBe(true);
      expect(stops).toBe(1);
      expect(exchanges).toBe(1);
    } finally {
      listener.mockRestore();
    }
  });
}

test("email start network failure closes the listener without reading input", async () => {
  let stops = 0;
  const listener = spyOn(Bun, "serve").mockReturnValue({
    port: 43123,
    stop: async () => {
      stops++;
    },
  } as never);
  try {
    await expect(
      emailLogin(
        {
          env: {},
          out: () => undefined,
          err: () => undefined,
          now: () => new Date(0),
          open: () => undefined,
          session: memorySessionStore(),
          fetch: async () => {
            throw new Error("Unavailable");
          },
          readCode: async () => {
            throw new Error("Must not read input");
          },
        },
        "user@example.test",
        "https://armada.example",
      ),
    ).rejects.toThrow("could not reach the server");
    expect(stops).toBe(1);
  } finally {
    listener.mockRestore();
  }
});

test("email login timeout cancels code input and closes its listener", async () => {
  let expire!: () => void;
  let aborted = false;
  let stops = 0;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    expire = callback;
    return 1;
  }) as unknown as typeof setTimeout);
  const listener = spyOn(Bun, "serve").mockReturnValue({
    port: 43123,
    stop: async () => {
      stops++;
    },
  } as never);
  try {
    await expect(
      emailLogin(
        {
          env: {},
          out: () => undefined,
          err: () => undefined,
          now: () => new Date(0),
          open: () => undefined,
          session: memorySessionStore(),
          fetch: async () => Response.json({}),
          readCode: (signal) =>
            new Promise((_, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(new Error("Cancelled"));
                },
                { once: true },
              );
              expire();
            }),
        },
        "user@example.test",
        "https://armada.example",
      ),
    ).rejects.toThrow("timed out");
    expect(aborted).toBe(true);
    expect(stops).toBe(1);
  } finally {
    timer.mockRestore();
    listener.mockRestore();
  }
});

test("email verification preserves typed failures and treats malformed sessions as service failures", async () => {
  const listener = spyOn(Bun, "serve").mockReturnValue({ port: 43123, stop: async () => undefined } as never);
  try {
    for (const [payload, status, code, message] of [
      [
        { error: { code: "unavailable", message: "Sign-in service is unavailable. Try again later." } },
        503,
        "unavailable",
        "Sign-in service is unavailable. Try again later.",
      ],
      [
        { error: { code: "unauthorized", message: "Sign-in code expired. Request a new code." } },
        401,
        "unauthorized",
        "Sign-in code expired. Request a new code.",
      ],
      [
        { internal: "private_diagnostic" },
        200,
        "unavailable",
        "Email sign-in could not finish because Armada returned an invalid session. Try signing in again; if this continues, contact the server operator.",
      ],
    ] as const) {
      await expect(
        emailLogin(
          {
            env: {},
            out: () => undefined,
            err: () => undefined,
            now: () => new Date(0),
            open: () => undefined,
            session: memorySessionStore(),
            readCode: async () => "123456",
            fetch: async (input) =>
              String(input).endsWith("/start") ? Response.json({}) : Response.json(payload, { status }),
          },
          "user@example.test",
          "https://armada.example",
        ),
      ).rejects.toMatchObject({ code, message });
    }
  } finally {
    listener.mockRestore();
  }
});
