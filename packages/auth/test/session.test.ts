import { describe, expect, test } from "bun:test";
import { AuthError, ensureFreshSession, memorySessionStore, refreshSession, type Session } from "../src/index.ts";

const session = (token = "access", refreshToken = "refresh"): Session => ({
  supabaseUrl: "https://project.supabase.co",
  accessToken: token,
  refreshToken,
  expiresAt: "2099-01-01T00:00:00.000Z",
  userId: "11111111-1111-4111-8111-111111111111",
});

describe("session refresh", () => {
  test("refreshes an expiring session and persists the rotated tokens", async () => {
    const store = memorySessionStore({ ...session(), expiresAt: "2026-11-08T00:00:10.000Z" });
    const next = await ensureFreshSession(store, new Date("2026-11-08T00:00:00.000Z"), async () =>
      session("new", "new-refresh"),
    );
    expect(next.accessToken).toBe("new");
    expect((await store.read())?.refreshToken).toBe("new-refresh");
  });

  test("does not overwrite another caller's rotated refresh token", async () => {
    const store = memorySessionStore(session("old", "rotated"));
    const next = await refreshSession(store, new Date(), async () => session("new", "new-refresh"), session());
    expect(next.refreshToken).toBe("rotated");
  });

  test("does not hide a failed refresh", async () => {
    const store = memorySessionStore(session());
    await expect(
      refreshSession(store, new Date(), async () => {
        throw new AuthError("Login failed.", "unauthorized");
      }),
    ).rejects.toThrow("Login failed");
    expect((await store.read())?.refreshToken).toBe("refresh");
  });
});
