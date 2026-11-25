import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { MODEL_CATALOG } from "@armada/core";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import SandboxesPage from "@/app/(app)/sandboxes/page";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as dockerHosts from "@/lib/data/docker-hosts";
import * as providerSetup from "@/lib/data/provider-setup";
import * as sandboxInventory from "@/lib/data/sandbox-inventory";
import * as sandboxesData from "@/lib/data/sandboxes";
import * as selectedOrg from "@/lib/data/selected-org";
import * as viewer from "@/lib/data/viewer";
import * as env from "@/lib/env";
import { LIVE_FLEET_REFRESH_EVENT, type LiveSandboxes } from "@/lib/live-sandbox-view";
import type { SandboxListMetadata } from "@/lib/sandbox-access";
import * as supabase from "@/lib/supabase/server";
import { NavLinks } from "./nav-links";
import { SandboxChat, SandboxThreadStateProvider, ThreadSandboxState } from "./sandbox-chat";
import { SandboxState } from "./sandbox-state";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const orig = {
  window: globalThis.window,
  document: globalThis.document,
  fetch: globalThis.fetch,
  EventSource: globalThis.EventSource,
};
const noop = () => {};
const router = {
  bfcacheId: "",
  back: noop,
  forward: noop,
  refresh: noop,
  push: noop,
  replace: noop,
  prefetch: noop,
} satisfies AppRouterInstance;

afterEach(() => {
  /* oxlint-disable landmines-testing/no-test-doubles -- Restore browser globals in the DOM-free renderer. */
  Object.assign(globalThis, orig);
  /* oxlint-enable landmines-testing/no-test-doubles */
});

function installDom(responder: (input: RequestInfo | URL) => Promise<Response>, innerWidth = 1280) {
  const windowEvents = new EventTarget();
  const documentEvents = new EventTarget();
  const fakeDocument = Object.assign(documentEvents, {
    hidden: false,
    visibilityState: "visible",
    hasFocus: () => true,
    cookie: "",
  });
  /* oxlint-disable landmines-testing/no-test-doubles -- Supply browser globals and HTTP responses in the DOM-free renderer without sockets or timers. */
  globalThis.window = Object.assign(windowEvents, {
    innerWidth,
    location: { origin: "https://dashboard.test" },
    matchMedia: () => ({ matches: innerWidth < 768, addEventListener: noop, removeEventListener: noop }),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  }) as unknown as Window & typeof globalThis;
  globalThis.document = fakeDocument as unknown as Document;
  globalThis.EventSource = undefined as unknown as typeof EventSource;
  globalThis.fetch = Object.assign(responder, { preconnect: orig.fetch.preconnect });
  /* oxlint-enable landmines-testing/no-test-doubles */
  return { windowEvents, documentEvents, fakeDocument };
}

test("SandboxState shows green pulsing Working across working states and never on idle or non-working states", () => {
  const workingCases: Parameters<typeof SandboxState>[0][] = [
    { status: "ready", activityLabel: "Working" },
    { status: "running" },
    { status: "starting", activityLabel: "Working" },
    { status: "stopped", activityLabel: "Working" },
    { status: "ready", viewerOwns: false, activityLabel: "Working" },
    { status: "stopped", idlePaused: true, expiresAt: "2099-01-01T00:00:00Z", activityLabel: "Working" },
  ];
  for (const props of workingCases) {
    const html = renderToString(<SandboxState {...props} />);
    expect(html).toContain(">Working<");
    expect(html).toContain('data-pulse="true"');
    expect(html).toContain("motion-safe:animate-live");
    expect(html).toContain("bg-success");
    expect(html).not.toContain("border-muted-foreground");
    expect(html).not.toContain("bg-muted-foreground/60");
  }
  const idleCases: [string, Parameters<typeof SandboxState>[0], string][] = [
    ["Ready", { status: "ready", readyLabel: "Ready" }, "bg-muted-foreground/60"],
    ["Waiting for you", { status: "ready", readyLabel: "Waiting for you" }, "bg-warning"],
    ["Waiting", { status: "ready", viewerOwns: false, readyLabel: "Ready" }, "bg-muted-foreground/60"],
    ["Finished", { status: "ready", readyLabel: "Finished" }, "bg-muted-foreground/60"],
    ["Working", { status: "running", statusMessage: "Waiting for a free agent slot" }, "bg-muted-foreground/60"],
    ["Stopped", { status: "stopped" }, "border-muted-foreground"],
    ["Paused", { status: "stopped", idlePaused: true, expiresAt: "2099-01-01T00:00:00Z" }, "border-muted-foreground"],
  ];
  for (const [label, props, expectedDot] of idleCases) {
    const html = renderToString(<SandboxState {...props} />);
    expect(html).toContain(`>${label}<`);
    expect(html).toContain(expectedDot);
    expect(html).not.toContain("bg-success");
    expect(html).not.toContain("data-pulse");
  }
});

test("NavLinks renders working ready/starting/stopped as pulsing Working and polls immediately on desktop", async () => {
  const responses: LiveSandboxes["rows"][] = [
    [
      { id: "s1", label: "modal-working", status: "ready", working: true },
      { id: "s2", label: "starting-queued", status: "starting", working: true },
      { id: "s3", label: "stopped-waking", status: "stopped", working: true },
      { id: "s4", label: "modal-idle", status: "ready", working: false },
    ],
    [{ id: "s1", label: "modal-working", status: "ready", working: false }],
  ];
  const urls: string[] = [];
  const { windowEvents } = installDom(async (input) => {
    urls.push(String(input));
    const rows = responses[Math.min(urls.length - 1, responses.length - 1)]!;
    return Response.json(rows, { headers: { "X-Live-Count": String(rows.length) } });
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <TooltipProvider>
        <AppRouterContext.Provider value={router}>
          <PathnameContext.Provider value="/sandboxes">
            <SidebarProvider>
              <NavLinks
                organizationId="org-1"
                initialLive={{
                  total: 1,
                  rows: [{ id: "s1", label: "modal-working", status: "ready", working: false }],
                }}
              />
            </SidebarProvider>
          </PathnameContext.Provider>
        </AppRouterContext.Provider>
      </TooltipProvider>,
    );
  });
  expect(urls).toEqual(["/api/fleet/live?organizationId=org-1"]);
  expect(renderer.root.findByProps({ href: "/sandboxes/s1" }).props.title).toBe("modal-working · Working");
  expect(renderer.root.findByProps({ href: "/sandboxes/s2" }).props.title).toBe("starting-queued · Working");
  expect(renderer.root.findByProps({ href: "/sandboxes/s3" }).props.title).toBe("stopped-waking · Working");
  const idleLink = renderer.root.findByProps({ href: "/sandboxes/s4" });
  expect(idleLink.props.title).toBe("modal-idle · Waiting for you");
  expect(renderer.root.findAllByProps({ "data-pulse": true })).toHaveLength(3);
  expect(idleLink.findAllByProps({ "data-pulse": true })).toHaveLength(0);
  await act(async () => {
    windowEvents.dispatchEvent(new CustomEvent(LIVE_FLEET_REFRESH_EVENT));
  });
  expect(urls).toHaveLength(2);
  expect(renderer.root.findByProps({ href: "/sandboxes/s1" }).props.title).toBe("modal-working · Waiting for you");
  await act(async () => renderer.unmount());

  const mobileUrls: string[] = [];
  installDom(async (input) => {
    mobileUrls.push(String(input));
    return Response.json([], { headers: { "X-Live-Count": "0" } });
  }, 390);
  await act(async () => {
    renderer = create(
      <TooltipProvider>
        <AppRouterContext.Provider value={router}>
          <PathnameContext.Provider value="/sandboxes">
            <SidebarProvider>
              <NavLinks organizationId="org-1" initialLive={{ total: 0, rows: [] }} />
            </SidebarProvider>
          </PathnameContext.Provider>
        </AppRouterContext.Provider>
      </TooltipProvider>,
    );
  });
  expect(mobileUrls).toEqual([]);
  await act(async () => renderer.unmount());
});

test("ThreadSandboxState live-updates between Working and Ready as turns start and finish on a ready sandbox", async () => {
  const mkPage = (status: string, state: string, cursor: string, backward = false) => ({
    status,
    usageRevision: "rev-1",
    configured: true,
    cursor,
    hasMore: false,
    backward,
    statusMessage: null,
    prompt: { state, conversationId: "conv-1" },
    events: [],
  });
  const pages = [
    mkPage("running", "running", "1", true),
    mkPage("ready", "finished", "2"),
    mkPage("ready", "running", "3"),
    mkPage("stopped", "queued", "4"),
  ];
  let i = 0;
  let refreshes = 0;
  const { windowEvents, documentEvents, fakeDocument } = installDom(async () =>
    Response.json(pages[Math.min(i++, pages.length - 1)]),
  );
  windowEvents.addEventListener(LIVE_FLEET_REFRESH_EVENT, () => {
    refreshes += 1;
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AppRouterContext.Provider value={router}>
        <SandboxThreadStateProvider>
          <header>
            <ThreadSandboxState
              viewerOwns
              status="running"
              statusMessage="Waiting for a free agent slot"
              readyLabel="Ready"
            />
          </header>
          <SandboxChat
            sandboxId="11111111-1111-4111-8111-111111111111"
            currentConversation="conv-1"
            initialStatus="running"
            initialUsageRevision="rev-1"
            live
            harness="codex"
            catalog={MODEL_CATALOG}
            launchedModel={null}
            configured
            pinnedModel
          />
        </SandboxThreadStateProvider>
      </AppRouterContext.Provider>,
    );
  });
  const headerText = () =>
    renderer.root
      .findByType("header")
      .findAll((node) => node.children.some((c) => typeof c === "string"))
      .flatMap((node) => node.children.filter((c): c is string => typeof c === "string"))
      .join("");
  const pulses = () => renderer.root.findByType("header").findAllByProps({ "data-pulse": true }).length;
  const pollNext = () =>
    act(async () => {
      fakeDocument.hidden = true;
      documentEvents.dispatchEvent(new Event("visibilitychange"));
      fakeDocument.hidden = false;
      documentEvents.dispatchEvent(new Event("visibilitychange"));
    });

  expect(headerText()).toBe("Working");
  expect(pulses()).toBe(1);
  expect(renderer.root.findByType("header").findAllByType("span")[0]?.props.title).toBeUndefined();
  expect(refreshes).toBe(0);
  await pollNext();
  expect(headerText()).toBe("Ready");
  expect(pulses()).toBe(0);
  expect(refreshes).toBe(1);
  await pollNext();
  expect(headerText()).toBe("Working");
  expect(pulses()).toBe(1);
  expect(refreshes).toBe(2);
  expect(JSON.stringify(renderer.toJSON())).toContain('"Interrupt"');
  await pollNext();
  expect(headerText()).toBe("Working");
  expect(pulses()).toBe(1);
  expect(JSON.stringify(renderer.toJSON())).not.toContain('"Interrupt"');
  expect(JSON.stringify(renderer.toJSON())).not.toContain("Steer the running turn");
  await act(async () => renderer.unmount());
});

const CLIPPING_CLASSES = new Set([
  "truncate",
  "overflow-hidden",
  "overflow-x-hidden",
  "overflow-y-hidden",
  "overflow-clip",
  "overflow-x-clip",
  "overflow-y-clip",
]);

function hasClippingClass(className: string | undefined) {
  return (className ?? "").split(/\s+/).some((token) => CLIPPING_CLASSES.has(token.split(":").at(-1) ?? ""));
}

function enclosingClassesFor(html: string, marker: string) {
  const index = html.indexOf(marker);
  expect(index).toBeGreaterThan(-1);
  const tagEnd = html.indexOf(">", index);
  expect(tagEnd).toBeGreaterThan(index);
  const stack: { tag: string; className: string }[] = [];
  const tagPattern = /<(\/?)([a-z0-9-]+)([^>]*)>/gi;
  for (const match of html.slice(0, tagEnd + 1).matchAll(tagPattern)) {
    const [, closing, tag, attrs] = match;
    if (!tag || attrs?.endsWith("/")) continue;
    if (closing) {
      while (stack.length > 0 && stack.pop()?.tag !== tag) {}
      continue;
    }
    const classMatch = attrs?.match(/\bclass="([^"]*)"/);
    stack.push({ tag, className: classMatch?.[1] ?? "" });
  }
  return stack.map((entry) => entry.className);
}

test("/sandboxes status cell keeps the pulsing Working halo unclipped while truncating label text and LifecycleHint", async () => {
  const createdAt = "2025-01-01T00:00:00Z";
  const org = { id: "org-1", name: "Example", created_at: createdAt };
  const membership = { org, role: "admin" } as const;
  const row: SandboxListMetadata = {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: org.id,
    ownerId: "user-1",
    provider: "modal",
    providerSandboxId: "sb-working",
    harness: "codex",
    model: "gpt-5",
    reasoningEffort: null,
    status: "ready",
    createdAt,
    stoppedAt: null,
    expiresAt: "2024-12-31T23:00:00Z",
    effectiveTtlSeconds: 3600,
    machineSize: "medium",
    taskOutcome: null,
    preservationNote: null,
    displayLabel: "Working sandbox",
    canOpen: true,
    canManage: true,
  };
  try {
    /* oxlint-disable landmines-testing/no-test-doubles -- Supply authenticated /sandboxes page reads without a Next request, control API, or database. */
    spyOn(viewer, "requireViewer").mockResolvedValue({ id: "user-1", email: "user@example.com", token: "test" });
    spyOn(viewer, "listMemberships").mockResolvedValue([membership]);
    spyOn(viewer, "memberDirectory").mockResolvedValue(new Map([["user-1", "user@example.com"]]));
    spyOn(selectedOrg, "selectedOrganization").mockResolvedValue(membership);
    spyOn(supabase, "createClient").mockResolvedValue({} as supabase.Supabase);
    spyOn(env, "mcpUrl").mockReturnValue(null);
    spyOn(providerSetup, "readProviderSetup").mockResolvedValue({
      state: "ready",
      status: { org: { ...org, role: "admin" }, ready: true, providers: [{ provider: "modal", configured: true }] },
    });
    spyOn(dockerHosts, "readSelectedDockerHosts").mockResolvedValue({ state: "disabled" });
    spyOn(sandboxInventory, "listSandboxMetadata").mockResolvedValue({ inventory: [row], skipped: 0 });
    spyOn(sandboxInventory, "loadSandboxInventory").mockResolvedValue({
      rows: [row],
      total: 1,
      inventoryTotal: 1,
      skipped: 0,
      facets: {
        status: new Map([["ready", 1]]),
        provider: new Map([["modal", 1]]),
        harness: new Map([["codex", 1]]),
        model: new Map([["gpt-5", 1]]),
        owner: new Map([["user-1", 1]]),
        size: new Map([["medium", 1]]),
      },
      activity: "all",
      counts: { all: 1, mine: 1, working: 1, need: 0, stopped: 0, failed: 0, deleted: 0 },
      page: 1,
      workingIds: new Set([row.id]),
      waitingIds: new Set(),
      now: new Date(createdAt),
    });
    spyOn(sandboxesData, "listSandboxEnrichment").mockResolvedValue(new Map());
    /* oxlint-enable landmines-testing/no-test-doubles */

    const stream = await renderToReadableStream(
      <AppRouterContext.Provider value={router}>
        <PathnameContext.Provider value="/sandboxes">
          <SearchParamsContext.Provider value={new URLSearchParams()}>
            <SandboxesPage searchParams={Promise.resolve({})} />
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </AppRouterContext.Provider>,
    );
    await stream.allReady;
    const html = await new Response(stream).text();
    const articleMatch = html.match(/<article\b[\s\S]*?<\/article>/);
    expect(articleMatch).not.toBeNull();
    const articleHtml = articleMatch![0];

    expect(articleHtml).toContain('data-pulse="true"');
    expect(articleHtml).toContain("motion-safe:animate-live");
    for (const className of enclosingClassesFor(articleHtml, 'data-pulse="true"')) {
      expect(hasClippingClass(className)).toBe(false);
    }
    expect(articleHtml).toMatch(/<span[^>]*class="[^"]*\btruncate\b[^"]*"[^>]*>Working<\/span>/);
    expect(articleHtml).toMatch(
      /<p[^>]*class="[^"]*\btruncate\b[^"]*"[^>]*data-lifecycle="overdue"[^>]*>Past deadline<\/p>/,
    );
  } finally {
    mock.restore();
  }
});
