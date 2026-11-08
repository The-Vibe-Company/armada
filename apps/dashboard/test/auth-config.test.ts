import { expect, test } from "bun:test";
import { enabledProviders, isOAuthProvider } from "../src/lib/auth-config.ts";

test("social login buttons follow the configuration and ignore unknown names", () => {
  expect(enabledProviders(undefined)).toEqual([]);
  expect(enabledProviders("")).toEqual([]);
  expect(enabledProviders("google, GitHub ,twitter")).toEqual(["github", "google"]);
  expect(isOAuthProvider("github")).toBe(true);
  expect(isOAuthProvider("twitter")).toBe(false);
});
