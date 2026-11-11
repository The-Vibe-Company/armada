import { expect, spyOn, test } from "bun:test";
import type { AuthFetch } from "@armada/auth";
import { AuthUnavailable, describeFailure, verifySupabaseUser } from "../src/caller.ts";

const id = "ABCDEF01-2345-6789-ABCD-0123456789AB";
const token = "secret.session.bearer";
const project = { supabaseUrl: "https://project.supabase.co", anonKey: "private-key" };

test("fresh verification accepts a UUID on every call and normalizes it", async () => {
  let calls = 0;
  const fetch: AuthFetch = async () => {
    calls++;
    return Response.json({ id });
  };
  expect(await verifySupabaseUser(token, { ...project, fetch })).toBe(id.toLowerCase());
  expect(await verifySupabaseUser(token, { ...project, fetch })).toBe(id.toLowerCase());
  expect(calls).toBe(2);
});

test("explicit credential refusals remain refusals and cancel unused bodies", async () => {
  for (const status of [400, 401, 403, 503]) {
    let cancelled = false;
    const fetch: AuthFetch = async () =>
      new Response(
        new ReadableStream({
          cancel: () => {
            cancelled = true;
          },
        }),
        { status },
      );
    const result = verifySupabaseUser(token, { ...project, fetch });
    if (status === 503) await expect(result).rejects.toBeInstanceOf(AuthUnavailable);
    else expect(await result).toBeNull();
    expect(cancelled).toBe(true);
  }
});

test("malformed successful responses are unavailable, never bad credentials or secret diagnostics", async () => {
  for (const body of ["not json", "null", "[]", "{}", '{"id":1}', '{"id":"not-a-uuid"}']) {
    await expect(
      verifySupabaseUser(token, { ...project, fetch: async () => new Response(body) }),
    ).rejects.toBeInstanceOf(AuthUnavailable);
  }
  const fetch: AuthFetch = async () => {
    throw new Error(token);
  };
  try {
    await verifySupabaseUser(token, { ...project, fetch });
    throw new Error("Expected unavailable");
  } catch (error) {
    expect(error).toBeInstanceOf(AuthUnavailable);
    expect(describeFailure(error)).not.toContain(token);
    expect(describeFailure(error)).not.toContain(project.anonKey);
  }
});

test("one deadline aborts stalled headers and stalled JSON consumption", async () => {
  for (const stage of ["headers", "body"]) {
    let expire: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      expire = callback;
      return {};
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const enteredBody = Promise.withResolvers<void>();
    const lateHeaders = Promise.withResolvers<Response>();
    const body = Promise.withResolvers<unknown>();
    const lateCancelled = Promise.withResolvers<void>();
    const fetch: AuthFetch = async (_input, init) => {
      signal = init?.signal ?? undefined;
      if (stage === "headers") return lateHeaders.promise;
      const response = new Response();
      response.json = () => {
        enteredBody.resolve();
        return body.promise;
      };
      return response;
    };
    try {
      const result = verifySupabaseUser(token, { ...project, fetch });
      const rejected = result.catch((error: unknown) => error);
      if (stage === "body") await enteredBody.promise;
      expect(signal?.aborted).toBe(false);
      expect(expire).toBeDefined();
      expire?.();
      expect(await rejected).toBeInstanceOf(AuthUnavailable);
      expect(signal?.aborted).toBe(true);
      expect(clear).toHaveBeenCalledTimes(1);
      lateHeaders.resolve(
        new Response(
          new ReadableStream({
            cancel: () => {
              lateCancelled.resolve();
            },
          }),
        ),
      );
      body.resolve({ id });
      if (stage === "headers") await lateCancelled.promise;
    } finally {
      timer.mockRestore();
      clear.mockRestore();
    }
  }
});
