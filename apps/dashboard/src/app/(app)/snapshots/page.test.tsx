import { expect, mock, spyOn, test } from "bun:test";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { renderToReadableStream } from "react-dom/server";
import * as control from "@/lib/control";
import * as connections from "@/lib/data/connections";
import * as dockerHosts from "@/lib/data/docker-hosts";
import * as dockerSnapshots from "@/lib/data/docker-snapshots";
import * as github from "@/lib/data/github";
import * as goldens from "@/lib/data/goldens";
import * as accounts from "@/lib/data/model-accounts";
import * as providerSetup from "@/lib/data/provider-setup";
import * as selectedOrg from "@/lib/data/selected-org";
import * as templates from "@/lib/data/templates";
import * as vault from "@/lib/data/variables";
import * as viewer from "@/lib/data/viewer";
import * as env from "@/lib/env";
import * as supabase from "@/lib/supabase/server";
import GoldensPage from "./page";

test("cloud and Docker snapshots render while dialog reads are pending", async () => {
  const deferred = Promise.withResolvers<void>();
  const createdAt = "2025-01-01T00:00:00Z";
  const org = { id: "org", name: "Example", created_at: createdAt };
  const membership = { org, role: "admin" } as const;
  const golden: goldens.GoldenRow = {
    id: "golden",
    org_id: org.id,
    owner_id: "user",
    name: "Cloud snapshot",
    visibility: "org",
    created_at: createdAt,
    config: {},
    provider: "modal",
    provider_snapshot_id: "snapshot",
    provider_sandbox_id: null,
    modal_workspace: null,
    modal_environment: null,
    modal_app_id: null,
    size_policy: null,
    removed_at: null,
    build_warnings: [],
    helper_receipt: null,
    baseline_version: null,
  };
  /* oxlint-disable landmines-testing/no-test-doubles -- Supply authenticated inventory reads and gate deferred reads without a Next request, provider, or database. */
  spyOn(viewer, "requireViewer").mockResolvedValue({ id: "user", email: "user@example.com", token: "test" });
  spyOn(viewer, "listMemberships").mockResolvedValue([membership]);
  spyOn(viewer, "memberDirectory").mockResolvedValue(new Map());
  spyOn(selectedOrg, "selectedOrganization").mockResolvedValue(membership);
  spyOn(supabase, "createClient").mockResolvedValue({} as supabase.Supabase);
  spyOn(env, "mcpUrl").mockReturnValue("https://example.test");
  spyOn(github, "getGitHubConnection").mockResolvedValue(null);
  spyOn(providerSetup, "readProviderSetup").mockResolvedValue({
    state: "ready",
    status: { org: { ...org, role: "admin" }, ready: true, providers: [{ provider: "modal", configured: true }] },
  });
  spyOn(goldens, "listGoldens").mockResolvedValue([golden]);
  spyOn(goldens, "listGoldenHistory").mockResolvedValue([golden]);
  spyOn(dockerHosts, "readSelectedDockerHosts").mockResolvedValue({ state: "disabled" });
  spyOn(dockerHosts, "readDockerLaunchOption").mockResolvedValue(null);
  spyOn(dockerSnapshots, "readSelectedDockerSnapshots").mockResolvedValue({
    state: "ready",
    currentVersion: null,
    snapshots: [
      {
        id: "docker",
        orgId: org.id,
        ownerId: "user",
        name: "Docker snapshot",
        provider: "docker",
        visibility: "org",
        hostId: "host",
        installationId: "installation",
        hostName: "Host",
        hostAvailable: true,
        definitionHash: "definition",
        status: "ready",
        image: "image",
        config: { repos: [], init: [] },
        createdAt,
        builtOnVersion: null,
      },
    ],
  });
  spyOn(control, "readGoldenCapabilities").mockImplementation(async () => {
    await deferred.promise;
    return { ok: true, maxGoldens: null };
  });
  for (const read of [
    spyOn(connections, "listSelectedConnections"),
    spyOn(accounts, "listSelectedAccounts"),
    spyOn(templates, "listSelectedTemplates"),
    spyOn(vault, "listSelectedVault"),
  ]) {
    read.mockImplementation(async () => {
      await deferred.promise;
      return { state: "not-configured" };
    });
  }
  /* oxlint-enable landmines-testing/no-test-doubles */
  try {
    const settledReadsDrained = new Promise<null>((resolve) => setImmediate(() => resolve(null)));
    const rendering = GoldensPage({ searchParams: Promise.resolve({}) }).then((element) =>
      renderToReadableStream(
        <AppRouterContext.Provider value={{} as AppRouterInstance}>{element}</AppRouterContext.Provider>,
      ),
    );
    const stream = await Promise.race([rendering, settledReadsDrained]);
    if (!stream) throw new Error("Snapshot inventory shell stalled on deferred reads.");
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let html = "";
    while (!html.includes("Docker snapshot")) {
      const chunk = await Promise.race([reader.read(), settledReadsDrained]);
      if (!chunk || chunk.done) break;
      html += decoder.decode(chunk.value, { stream: true });
    }
    expect(html).toContain("Cloud snapshot");
    expect(html).toContain("Docker snapshot");
    expect(html).toContain("Loading launch options…");
    expect(html).not.toContain("Modal has no snapshot limit.");
    deferred.resolve();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      html += decoder.decode(chunk.value, { stream: true });
    }
    expect(html).toContain("Modal has no snapshot limit.");
  } finally {
    deferred.resolve();
    mock.restore();
  }
});
