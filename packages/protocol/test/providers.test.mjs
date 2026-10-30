import assert from "node:assert/strict";
import { test } from "node:test";
import { admitRequest, providersCatalogSchema, PROTOCOL_VERSION as version } from "../dist/index.js";

test("provider requests use the shared envelope and catalogs accept only public connection metadata", () => {
  for (const body of [
    { type: "providers.list", id: "list" },
    { type: "providers.answer", id: "prompt", value: "one answer" },
    { type: "providers.cancel", id: "cancel" },
    { type: "providers.connect", id: "codex" },
    { type: "providers.connect", id: "connect", provider: "codex" },
    { type: "providers.disconnect", id: "disconnect", provider: "codex" },
    { type: "providers.answer", id: "answer", flow: "connect", promptId: "prompt", value: "one answer" },
    { type: "providers.cancel", id: "cancel", flow: "connect" },
  ])
    assert.equal(admitRequest({ version, ...body }).ok, true);
  const provider = {
    id: "codex",
    seam: "agent",
    name: "Codex",
    mark: "codex",
    version: "0.99.0",
    state: "connected",
    account: { label: "Mira", plan: "ChatGPT Pro" },
    enabled: true,
    config: { binary: "/opt/bin/codex" },
    restartRequired: false,
  };
  const frame = { type: "providers.catalog", version, id: "catalog", providers: [provider] };
  assert.equal(providersCatalogSchema.safeParse(frame).success, true);
  assert.equal(
    providersCatalogSchema.safeParse({ ...frame, providers: [{ ...provider, token: "untrusted" }] }).success,
    false,
  );
  assert.equal(
    providersCatalogSchema.safeParse({
      ...frame,
      providers: [{ ...provider, config: { ...provider.config, apiKey: "untrusted" } }],
    }).success,
    false,
  );
});
