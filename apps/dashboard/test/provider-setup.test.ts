import { expect, test } from "bun:test";
import { parseProviderStatus, providerSetupValue, safeConnectMessage } from "../src/lib/provider-setup.ts";

const ORG = "00000000-0000-4000-8000-000000000013";
const status = (fields: Record<string, unknown> = {}) => ({
  org: { id: ORG, name: "Orion", role: "admin" },
  ready: true,
  providers: [
    { provider: "boat", configured: true },
    { provider: "modal", configured: false },
  ],
  ...fields,
});

test("a status is accepted only for the org asked about and only when it is self-consistent", () => {
  expect(parseProviderStatus(status(), ORG)?.ready).toBe(true);
  // Another org's answer, a ready flag no provider backs, a duplicate or unknown provider: never read as ready.
  expect(parseProviderStatus(status(), "00000000-0000-4000-8000-000000000010")).toBeNull();
  expect(
    parseProviderStatus(
      status({
        providers: [
          { provider: "boat", configured: false },
          { provider: "modal", configured: false },
        ],
      }),
      ORG,
    ),
  ).toBeNull();
  expect(
    parseProviderStatus(
      status({
        providers: [
          { provider: "boat", configured: true },
          { provider: "boat", configured: true },
        ],
      }),
      ORG,
    ),
  ).toBeNull();
  expect(parseProviderStatus(status({ providers: [{ provider: "vercel", configured: true }] }), ORG)).toBeNull();
  expect(parseProviderStatus(status({ ready: "yes" }), ORG)).toBeNull();
  expect(parseProviderStatus(null, ORG)).toBeNull();
  // A partial provider list is unexpected, not pending.
  expect(parseProviderStatus(status({ ready: false, providers: [] }), ORG)).toBeNull();
  expect(parseProviderStatus(status({ providers: [{ provider: "boat", configured: true }] }), ORG)).toBeNull();
  const pending = parseProviderStatus(
    status({
      ready: false,
      providers: [
        { provider: "boat", configured: false },
        { provider: "modal", configured: false },
      ],
    }),
    ORG,
  );
  expect(pending?.ready).toBe(false);
});

test("the connect value is the trimmed Boat key or the canonical Modal pair, and errors never repeat it", () => {
  expect(providerSetupValue("boat", { boatKey: "  bk_live_123  ", modalTokenId: "", modalTokenSecret: "" })).toEqual({
    ok: true,
    value: "bk_live_123",
  });
  const spaced = providerSetupValue("boat", { boatKey: "bk live", modalTokenId: "", modalTokenSecret: "" });
  expect(spaced.ok).toBe(false);
  if (!spaced.ok) expect(spaced.error).not.toContain("bk live");
  const modal = providerSetupValue("modal", {
    boatKey: "ignored",
    modalTokenId: "ak-AbCdEf123456",
    modalTokenSecret: "as-ZyXwVu987654",
  });
  expect(modal.ok && JSON.parse(modal.value)).toEqual({ token_id: "ak-AbCdEf123456", token_secret: "as-ZyXwVu987654" });
  expect(providerSetupValue("modal", { boatKey: "", modalTokenId: "ak-AbCdEf123456", modalTokenSecret: "" }).ok).toBe(
    false,
  );
});

test("a server message that contains a typed secret is replaced", () => {
  expect(safeConnectMessage("Boat refused key bk_live_123.", ["bk_live_123"])).not.toContain("bk_live_123");
  expect(safeConnectMessage("Boat refused these credentials.", ["bk_live_123"])).toBe(
    "Boat refused these credentials.",
  );
});
