import { expect, test } from "bun:test";
import { verifyEmailCode } from "../src/supabase-auth.ts";

// The auth boundary owns safe diagnosis; upstream bodies must never become user messages.
test("session failures distinguish refusal, service availability and invalid responses without leaking upstream text", async () => {
  const cases = [
    {
      response: new Response("private_diagnostic", { status: 401 }),
      code: "unauthorized",
      message:
        "Sign-in was refused because the code or login request is invalid, expired, or already used. Start sign-in again to get a new code or link.",
    },
    {
      response: new Response("private_diagnostic", { status: 503 }),
      code: "unavailable",
      message: "Sign-in could not finish because the sign-in service is unavailable. Try again later.",
    },
    {
      response: new Response("private_diagnostic", { status: 429 }),
      code: "unavailable",
      message: "Sign-in is temporarily rate limited. Wait a few minutes before trying again.",
    },
    {
      response: new Response("private_diagnostic"),
      code: "unavailable",
      message:
        "Sign-in could not finish because the sign-in service returned an invalid session. Try signing in again; if this continues, contact the server operator.",
    },
    {
      response: Response.json({ access_token: "private_diagnostic", user: {} }),
      code: "unavailable",
      message:
        "Sign-in could not finish because the sign-in service returned an invalid session. Try signing in again; if this continues, contact the server operator.",
    },
    {
      response: null,
      code: "unavailable",
      message: "Sign-in could not reach the sign-in service. Check your connection and try again.",
    },
  ];
  for (const entry of cases) {
    const result = verifyEmailCode({
      fetch: async () => {
        if (!entry.response) throw new Error("private_diagnostic");
        return entry.response;
      },
      supabaseUrl: "https://auth.test",
      anonKey: "anon_key",
      email: "person@example.test",
      code: "123456",
      now: new Date(0),
    });
    await expect(result).rejects.toMatchObject({ code: entry.code, message: entry.message });
  }
});
