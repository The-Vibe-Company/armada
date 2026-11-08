import { describe, expect, test } from "bun:test";
import { decryptSecret, encryptSecret } from "@armada/core";
import { configFromEnv } from "../src/config.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const ENV = {
  ARMADA_DATABASE_URL: "postgres://postgres:pw@db.example.com:5432/postgres",
  SUPABASE_URL: "https://project.supabase.co/",
  SUPABASE_ANON_KEY: "anon",
  ARMADA_AUTH_SECRET: "a-test-auth-secret-of-enough-length",
  ARMADA_PUBLIC_URL: "https://armada.example.com",
  ARMADA_ENCRYPTION_KEY: ENCRYPTION_KEY,
};

describe("config", () => {
  test("reads the environment, with PORT defaulting to 8080", () => {
    expect(configFromEnv(ENV)).toMatchObject({ port: 8080, supabaseUrl: "https://project.supabase.co" });
    expect(configFromEnv({ ...ENV, PORT: "3000" }).port).toBe(3000);
  });

  test("names every missing variable and never echoes a value", () => {
    expect(() => configFromEnv({ SUPABASE_ANON_KEY: "anon" })).toThrow(
      "Set ARMADA_DATABASE_URL, SUPABASE_URL, ARMADA_AUTH_SECRET, ARMADA_PUBLIC_URL, ARMADA_ENCRYPTION_KEY.",
    );
    expect(() => configFromEnv({ ...ENV, ARMADA_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(/must be 32 bytes/);
    expect(() => configFromEnv({ ...ENV, ARMADA_PUBLIC_URL: "http://armada.example.com/x" })).toThrow(/origin/);
    expect(() => configFromEnv({ ...ENV, PORT: "http" })).toThrow(/PORT/);
  });
});

test("a secret sealed with the key opens with it, and not with another key", async () => {
  const sealed = await encryptSecret("sk-ant-oat01-example", ENCRYPTION_KEY);
  expect(await decryptSecret(sealed, ENCRYPTION_KEY)).toBe("sk-ant-oat01-example");
  await expect(decryptSecret(sealed, btoa("x".repeat(32)))).rejects.toThrow();
});
