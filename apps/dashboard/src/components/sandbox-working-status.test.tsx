import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { MODEL_CATALOG } from "@armada/core";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import SandboxesPage from "@/app/(app)/sandboxes/page";
import * as sandboxActions from "@/app/actions/sandboxes";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { clearChatCache, setChatCache } from "@/lib/chat-cache";
import { SEND_KEY_FIELD } from "@/lib/composer";
import * as dockerHosts from "@/lib/data/docker-hosts";
import * as providerSetup from "@/lib/data/provider-setup";
import * as sandboxInventory from "@/lib/data/sandbox-inventory";
import * as sandboxesData from "@/lib/data/sandboxes";
import * as selectedOrg from "@/lib/data/selected-org";
import * as viewer from "@/lib/data/viewer";
import * as env from "@/lib/env";
import { LIVE_FLEET_CHANGE_EVENT, LIVE_FLEET_REFRESH_EVENT, type LiveSandboxes } from "@/lib/live-sandbox-view";
import type { SandboxListMetadata } from "@/lib/sandbox-access";
import * as supabase from "@/lib/supabase/server";
import { NavLinks } from "./nav-links";
import { SandboxChat, SandboxThreadStateProvider, ThreadSandboxState } from "./sandbox-chat";
import { SandboxListLiveSync } from "./sandbox-list-live-sync";
import { SandboxState } from "./sandbox-state";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const orig = {
  window: globalThis.window,
  document: globalThis.document,
  fetch: globalThis.fetch,
  EventSource: globalThis.EventSource,
  ResizeObserver: globalThis.ResizeObserver,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
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
  clearChatCache();
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

test("NavLinks skips redundant SSR mount poll, broadcasts live fingerprint changes, and syncs /sandboxes", async () => {
  const responses: LiveSandboxes["rows"][] = [
    [
      { id: "s1", label: "modal-working", status: "ready", working: true },
      { id: "s2", label: "starting-queued", status: "starting", working: true },
      { id: "s3", label: "stopped-waking", status: "stopped", working: true },
      { id: "s4", label: "modal-idle", status: "ready", working: false },
    ],
    [
      { id: "s1", label: "modal-working", status: "ready", working: true },
      { id: "s2", label: "starting-queued", status: "starting", working: true },
      { id: "s3", label: "stopped-waking", status: "stopped", working: true },
      { id: "s4", label: "modal-idle", status: "ready", working: false },
    ],
    [{ id: "s1", label: "modal-working", status: "ready", working: false }],
  ];
  const urls: string[] = [];
  let refreshes = 0;
  const spyRouter = { ...router, refresh: () => (refreshes += 1) } satisfies AppRouterInstance;
  const { windowEvents } = installDom(async (input) => {
    urls.push(String(input));
    const rows = responses[Math.min(urls.length - 1, responses.length - 1)]!;
    return Response.json(rows, { headers: { "X-Live-Count": String(rows.length) } });
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <TooltipProvider>
        <AppRouterContext.Provider value={spyRouter}>
          <PathnameContext.Provider value="/sandboxes">
            <SidebarProvider>
              <NavLinks
                organizationId="org-1"
                initialLive={{
                  total: 1,
                  rows: [{ id: "s1", label: "modal-working", status: "ready", working: false }],
                }}
              />
              <SandboxListLiveSync organizationId="org-1" />
            </SidebarProvider>
          </PathnameContext.Provider>
        </AppRouterContext.Provider>
      </TooltipProvider>,
    );
  });
  expect(urls).toEqual([]);
  expect(refreshes).toBe(0);
  expect(renderer.root.findByProps({ href: "/sandboxes/s1" }).props.title).toBe("modal-working · Waiting for you");
  await act(async () => {
    windowEvents.dispatchEvent(new CustomEvent(LIVE_FLEET_REFRESH_EVENT));
  });
  expect(urls).toEqual(["/api/fleet/live?organizationId=org-1"]);
  expect(refreshes).toBe(1);
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
  expect(refreshes).toBe(1);
  await act(async () => {
    windowEvents.dispatchEvent(new CustomEvent(LIVE_FLEET_REFRESH_EVENT));
  });
  expect(urls).toHaveLength(3);
  expect(refreshes).toBe(2);
  expect(renderer.root.findByProps({ href: "/sandboxes/s1" }).props.title).toBe("modal-working · Waiting for you");
  await act(async () => {
    windowEvents.dispatchEvent(new CustomEvent(LIVE_FLEET_CHANGE_EVENT, { detail: { organizationId: "org-2" } }));
  });
  expect(refreshes).toBe(2);
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
              <NavLinks organizationId="org-1" initialLive={null} />
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
            orgId="org-1"
            sandboxId="11111111-1111-4111-8111-111111111111"
            currentConversation="conv-1"
            initialStatus="running"
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
      counts: { all: 1, active: 1, need: 0, stopped: 0, failed: 0 },
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
    expect(html).toContain("1 working");
    expect(html).not.toContain('aria-label="Sandbox scope"');
  } finally {
    mock.restore();
  }
});

function mountChat(
  sandboxId: string,
  initialStatus: "ready" | "running",
  routerOverride: AppRouterInstance = router,
  createNodeMock?: (el: { type: unknown }) => unknown,
) {
  return create(
    <AppRouterContext.Provider value={routerOverride}>
      <SandboxThreadStateProvider>
        <header>
          <ThreadSandboxState viewerOwns status={initialStatus} readyLabel="Ready" />
        </header>
        <SandboxChat
          key={sandboxId}
          orgId="org-1"
          sandboxId={sandboxId}
          currentConversation="c1"
          initialStatus={initialStatus}
          live
          harness="claude"
          catalog={MODEL_CATALOG}
          launchedModel={null}
          configured
          pinnedModel
        />
      </SandboxThreadStateProvider>
    </AppRouterContext.Provider>,
    createNodeMock ? { createNodeMock } : undefined,
  );
}

test("SandboxChat connects SSE cursor=tail in parallel with history, stitches buffered inline frames, pauses polling, and avoids router.refresh", async () => {
  const sandboxId = "22222222-2222-4222-8222-222222222222";
  const streams: Array<{
    url: string;
    onopen?: () => void;
    onerror?: () => void;
    onmessage?: (message: { lastEventId: string; data: string }) => void;
  }> = [];
  class FakeEventSource {
    onopen?: () => void;
    onerror?: () => void;
    onmessage?: (message: { lastEventId: string; data: string }) => void;
    constructor(readonly url: string) {
      streams.push(this);
    }
    close() {}
  }
  let resolveHistory!: (response: Response) => void;
  const fetchedUrls: string[] = [];
  const scheduledPolls: number[] = [];
  let refreshCalls = 0;
  installDom(async (input) => {
    fetchedUrls.push(String(input));
    if (fetchedUrls.length === 1)
      return new Promise<Response>((resolve) => {
        resolveHistory = resolve;
      });
    return Response.json({
      status: "ready",
      configured: true,
      cursor: `ar1_${sandboxId}_3`,
      hasMore: false,
      events: [],
    });
  });
  /* oxlint-disable landmines-testing/no-test-doubles -- Supply deterministic EventSource and timer spy in the DOM-free renderer. */
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const origSetTimeout = globalThis.setTimeout;
  const spyRouter = { ...router, refresh: () => (refreshCalls += 1) } satisfies AppRouterInstance;
  globalThis.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 1_000 || delay === 3_000) scheduledPolls.push(delay);
    return origSetTimeout(fn, delay, ...args);
  }) as unknown as typeof setTimeout;
  /* oxlint-enable landmines-testing/no-test-doubles */

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = mountChat(sandboxId, "running", spyRouter);
    });
    expect(streams[0]!.url).toBe(`/api/v1/events?sandbox=${sandboxId}&cursor=tail`);
    expect(fetchedUrls).toHaveLength(1);

    await act(async () => {
      streams[0]!.onopen!();
      streams[0]!.onmessage!({
        lastEventId: "10",
        data: JSON.stringify({
          id: "10",
          sandboxId,
          sequence: "2",
          kind: "runtime_event",
          event: { id: "ev-2", at: 2, kind: "message", text: "early inline reply", partial: false, tools: [] },
        }),
      });
    });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("early inline reply");

    await act(async () => {
      resolveHistory(
        Response.json({
          status: "running",
          configured: true,
          cursor: `ar1_${sandboxId}_1`,
          hasMore: false,
          backward: true,
          prompt: { state: "running", conversationId: "c1" },
          events: [
            { id: "ev-1", at: 1, kind: "prompt", text: "hi", status: "running", promptId: "p1", conversationId: "c1" },
          ],
        }),
      );
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("early inline reply");
    expect(fetchedUrls).toHaveLength(1);
    expect(scheduledPolls).toEqual([]);

    await act(async () => {
      streams[0]!.onmessage!({
        lastEventId: "11",
        data: JSON.stringify({
          id: "11",
          sandboxId,
          sequence: "3",
          kind: "runtime_event",
          event: {
            id: "ev-3",
            at: 3,
            kind: "prompt",
            text: "hi",
            status: "finished",
            promptId: "p1",
            conversationId: "c1",
          },
        }),
      });
      streams[0]!.onmessage!({
        lastEventId: "12",
        data: JSON.stringify({
          id: "12",
          sandboxId,
          sequence: null,
          kind: "transition",
          status: "ready",
          statusReason: null,
        }),
      });
    });
    expect(fetchedUrls).toHaveLength(1);
    expect(refreshCalls).toBe(0);
    expect(scheduledPolls).toEqual([]);
    expect(renderer.root.findByType("header").findAllByProps({ "data-pulse": true })).toHaveLength(0);

    await act(async () => {
      streams[0]!.onmessage!({
        lastEventId: "13",
        data: JSON.stringify({
          id: "13",
          sandboxId,
          sequence: "1",
          kind: "runtime_event",
          event: {
            id: "ev-1",
            at: 1,
            kind: "prompt",
            text: "hi",
            status: "running",
            promptId: "p1",
            conversationId: "c1",
          },
        }),
      });
    });
    expect(renderer.root.findByType("header").findAllByProps({ "data-pulse": true })).toHaveLength(0);

    await act(async () => {
      streams[0]!.onerror!();
    });
    expect(scheduledPolls).toEqual([3_000]);
  } finally {
    globalThis.setTimeout = origSetTimeout;
    await act(async () => renderer.unmount());
  }
});

test("SandboxChat runs a catch-up read when a cursor=tail stream opens after history already synced", async () => {
  const sandboxId = "44444444-4444-4444-8444-444444444444";
  const streams: Array<{ onopen?: () => void }> = [];
  class FakeEventSource {
    onopen?: () => void;
    onerror?: () => void;
    onmessage?: (message: { lastEventId: string; data: string }) => void;
    constructor(readonly url: string) {
      streams.push(this);
    }
    close() {}
  }
  const fetchedUrls: string[] = [];
  installDom(async (input) => {
    fetchedUrls.push(String(input));
    return Response.json({
      status: "ready",
      configured: true,
      cursor: `ar1_${sandboxId}_${fetchedUrls.length}`,
      hasMore: false,
      backward: fetchedUrls.length === 1,
      prompt: { state: "finished", conversationId: "c1" },
      events:
        fetchedUrls.length === 2
          ? [{ id: "ev-gap", at: 2, kind: "message", text: "caught up", partial: false, tools: [] }]
          : [],
    });
  });
  /* oxlint-disable landmines-testing/no-test-doubles -- Supply deterministic EventSource for tail-open catch-up verification. */
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  /* oxlint-enable landmines-testing/no-test-doubles */

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = mountChat(sandboxId, "ready", router);
    });
    expect(fetchedUrls).toHaveLength(1);
    await act(async () => {
      streams[0]!.onopen!();
    });
    expect(fetchedUrls).toHaveLength(2);
    expect(JSON.stringify(renderer.toJSON())).toContain("caught up");
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("SandboxChat hydrates synchronously from LRU cache and supports 0ms optimistic send, steer, and interrupt", async () => {
  const sandboxId = "33333333-3333-4333-8333-333333333333";
  setChatCache("org-1", sandboxId, {
    history: {
      events: [{ id: "ev-1", at: 1, kind: "message", text: "hydrated from cache", partial: false, tools: [] }],
      cursor: `ar1_${sandboxId}_1`,
      olderCursor: null,
      loaded: true,
    },
    status: "ready",
    statusMessage: null,
    hasLiveStatus: true,
    idlePaused: false,
    turnModel: { state: "finished", conversationId: "c1" },
    updatedAt: Date.now(),
  });

  const fetchedUrls: string[] = [];
  installDom(async (input) => {
    fetchedUrls.push(String(input));
    return new Promise<Response>(() => {});
  });
  let resolveSend!: (result: { ok: true; message: string; promptId?: string } | { ok: false; error: string }) => void;
  let resolveSteer!: (result: { ok: true; message: string } | { ok: false; error: string }) => void;
  let resolveInterrupt!: (result: { ok: true; message: string } | { ok: false; error: string }) => void;
  const sentKeys: string[] = [];
  /* oxlint-disable landmines-testing/no-test-doubles -- Control server action settlement timing to assert 0ms optimistic UI state. */
  spyOn(sandboxActions, "sendToSandbox").mockImplementation(async (_prev, data) => {
    sentKeys.push(String(data.get(SEND_KEY_FIELD) ?? ""));
    return new Promise((resolve) => {
      resolveSend = resolve;
    });
  });
  spyOn(sandboxActions, "steerSandbox").mockImplementation(
    async () =>
      new Promise((resolve) => {
        resolveSteer = resolve;
      }),
  );
  spyOn(sandboxActions, "interruptSandbox").mockImplementation(
    async () =>
      new Promise((resolve) => {
        resolveInterrupt = resolve;
      }),
  );
  /* oxlint-enable landmines-testing/no-test-doubles */

  let renderer!: ReactTestRenderer;
  const formStub = { elements: { namedItem: () => null }, reset: noop, requestSubmit: noop };
  const nodeMock = (el: { type: unknown }) => (el.type === "form" ? formStub : null);
  const textarea = () => renderer.root.findByType("textarea");
  const buttonText = (node: ReturnType<typeof renderer.root.findByType>) =>
    node
      .findAll((child) => child.children.some((c) => typeof c === "string"))
      .flatMap((child) => child.children.filter((c): c is string => typeof c === "string"))
      .join("");
  const buttonByText = (label: string) =>
    renderer.root.findAllByType("button").find((node) => buttonText(node).includes(label))!;
  try {
    await act(async () => {
      renderer = mountChat(sandboxId, "ready", router, nodeMock);
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("hydrated from cache");
    expect(renderer.root.findAllByProps({ "data-testid": "history-loading" })).toHaveLength(0);
    expect(fetchedUrls[0]).toContain(`/api/sandboxes/${sandboxId}/events?cursor=ar1_${sandboxId}_1`);

    await act(async () => {
      textarea().props.onChange({ target: { value: "Fix tests" } });
    });
    await act(async () => {
      buttonByText("Send").props.onClick();
    });
    expect(textarea().props.value).toBe("");
    expect(textarea().props.disabled).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).toContain("Fix tests");
    expect(renderer.root.findAllByProps({ "data-testid": "agent-working" })).toHaveLength(1);
    expect(renderer.root.findByType("header").findAllByProps({ "data-pulse": true })).toHaveLength(1);

    await act(async () => {
      resolveSend({ ok: false, error: "This sandbox needs an account before it can resume." });
    });
    expect(textarea().props.value).toBe("Fix tests");
    await act(async () => {
      buttonByText("Send").props.onClick();
    });
    expect(sentKeys[0]).toBe(sentKeys[1]);
    await act(async () => {
      textarea().props.onChange({ target: { value: "Follow-up draft" } });
    });
    await act(async () => {
      resolveSend({ ok: true, message: "Sent.", promptId: "p-accepted" });
    });
    expect(textarea().props.value).toBe("Follow-up draft");
    await act(async () => renderer.unmount());

    setChatCache("org-1", sandboxId, {
      history: {
        events: [
          { id: "ev-p", at: 1, kind: "prompt", text: "work", status: "running", promptId: "p1", conversationId: "c1" },
        ],
        cursor: `ar1_${sandboxId}_2`,
        olderCursor: null,
        loaded: true,
      },
      status: "running",
      statusMessage: null,
      hasLiveStatus: true,
      idlePaused: false,
      turnModel: { state: "running", conversationId: "c1" },
      updatedAt: Date.now(),
    });
    await act(async () => {
      renderer = mountChat(sandboxId, "running", router, nodeMock);
    });
    await act(async () => {
      textarea().props.onChange({ target: { value: "Check edge cases" } });
    });
    await act(async () => {
      buttonByText("Steer").props.onClick();
    });
    expect(textarea().props.value).toBe("");
    expect(JSON.stringify(renderer.toJSON())).toContain("Check edge cases");
    await act(async () => {
      resolveSteer({ ok: true, message: "Steered." });
    });

    await act(async () => {
      buttonByText("Interrupt").props.onClick();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Interrupting…");
    await act(async () => {
      resolveInterrupt({ ok: true, message: "Interrupt requested." });
    });
  } finally {
    mock.restore();
    await act(async () => renderer?.unmount());
  }
});

test("SandboxChat observes inner <ol>, stays pinned on tool updates, smoothly collapses ToolGroup with elapsed timer, and supports composer auto-focus, auto-grow and shortcuts", async () => {
  const [sandboxA, sandboxB, t0] = [
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
    Date.now() - 4_200,
  ];
  const toolEv = (id: string, tools: unknown[], partial = true) =>
    ({ id, at: t0, kind: "message", text: "", partial, promptId: "p1", conversationId: "c1", tools }) as never;
  const [observed, streams] = [
    [] as unknown[],
    [] as Array<{ onopen?: () => void; onmessage?: (m: { lastEventId: string; data: string }) => void }>,
  ];
  let onResize: (() => void) | null = null;
  setChatCache("org-1", sandboxA, {
    history: {
      events: [
        { id: "ev-1", at: t0, kind: "prompt", text: "Run", status: "running", promptId: "p1", conversationId: "c1" },
        toolEv("ev-2", [{ id: "tool-1", name: "Bash", input: { command: "bun test" } }]),
      ],
      cursor: `ar1_${sandboxA}_2`,
      olderCursor: null,
      loaded: true,
    },
    status: "running",
    statusMessage: null,
    hasLiveStatus: true,
    idlePaused: false,
    turnModel: { state: "running", conversationId: "c1" },
    updatedAt: t0,
  });
  const { windowEvents } = installDom(async (input) => {
    const isB = String(input).includes(sandboxB);
    return Response.json({
      status: isB ? "ready" : "running",
      configured: true,
      cursor: `ar1_${isB ? sandboxB : sandboxA}_2`,
      hasMore: false,
      prompt: { state: isB ? "finished" : "running", conversationId: "c1" },
      events: [],
    });
  });
  const sent: string[] = [];
  let interrupts = 0;
  class FakeRO {
    constructor(cb: () => void) {
      onResize = cb;
    }
    observe = (t: unknown) => observed.push(t);
    disconnect = noop;
  }
  class FakeES {
    onopen?: () => void;
    onmessage?: (m: { lastEventId: string; data: string }) => void;
    close = noop;
    constructor() {
      streams.push(this);
    }
  }
  /* oxlint-disable landmines-testing/no-test-doubles -- Supply ResizeObserver, rAF, EventSource and action spies in DOM-free renderer. */
  Object.assign(globalThis, {
    ResizeObserver: FakeRO,
    EventSource: FakeES,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
  });
  spyOn(sandboxActions, "sendToSandbox").mockImplementation(async (_p, d) => ({
    ok: true,
    message: "Sent.",
    promptId: `p-${sent.push(String(d.get("prompt") ?? ""))}`,
  }));
  spyOn(sandboxActions, "interruptSandbox").mockImplementation(async () => ({
    ok: true,
    message: `i-${++interrupts}`,
  }));
  /* oxlint-enable landmines-testing/no-test-doubles */

  const [scroller, focusCalls] = [{ scrollTop: 0, scrollHeight: 400, clientHeight: 200 }, [] as unknown[]];
  const taNode = { style: { height: "", overflowY: "" }, scrollHeight: 88, focus: (o?: unknown) => focusCalls.push(o) };
  const stubs: Record<string, unknown> = {
    ol: { tagName: "OL" },
    form: { elements: { namedItem: () => null }, reset: noop, requestSubmit: noop },
    textarea: taNode,
  };
  const nodeMock = (el: { type: unknown; props?: unknown }) =>
    el.type === "div" && (el.props as Record<string, unknown> | undefined)?.["data-fit"] === "history-scroll"
      ? scroller
      : typeof el.type === "string"
        ? (stubs[el.type] ?? null)
        : null;
  const key = (k: string, x: Record<string, unknown> = {}) =>
    Object.assign({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, preventDefault: noop }, x);

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = mountChat(sandboxA, "running", router, nodeMock);
    });
    expect(observed).toEqual(expect.arrayContaining([scroller, stubs.ol]));
    expect([scroller.scrollTop, focusCalls, taNode.style]).toEqual([
      400,
      [{ preventScroll: true }],
      { height: "88px", overflowY: "hidden" },
    ]);

    scroller.scrollHeight = 520;
    await act(async () => onResize?.());
    expect([
      scroller.scrollTop,
      renderer.root.findByProps({ "data-tool-elapsed": true }).children.join(""),
      renderer.root.findByProps({ "data-tool-group-body": "open" }).props.className.includes("grid-rows-[1fr]"),
    ]).toEqual([520, expect.stringMatching(/^\d+s$/), true]);

    const ta = () => renderer.root.findByType("textarea");
    await act(async () => ta().props.onKeyDown(key("Escape")));
    await act(async () => {
      windowEvents.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), key("Escape")));
    });
    expect(interrupts).toBe(2);

    scroller.scrollHeight = 600;
    const done = toolEv("ev-3", [{ id: "tool-1", name: "Bash", result: { output: "ok", isError: false } }], false);
    await act(async () => {
      streams[0]!.onopen?.();
      streams[0]!.onmessage?.({
        lastEventId: "3",
        data: JSON.stringify({ id: "3", sandboxId: sandboxA, sequence: "3", kind: "runtime_event", event: done }),
      });
    });
    expect([
      scroller.scrollTop,
      renderer.root.findAllByProps({ "data-tool-elapsed": true }).length,
      renderer.root.findByProps({ "data-tool-group-body": "closed" }).props.className.includes("grid-rows-[0fr]"),
    ]).toEqual([600, 0, true]);

    await act(async () => renderer.unmount());
    await act(async () => {
      renderer = mountChat(sandboxB, "ready", router, nodeMock);
    });
    expect(focusCalls).toHaveLength(2);

    taNode.scrollHeight = 400;
    await act(async () => ta().props.onChange({ target: { value: "Line 1\nLine 2" } }));
    expect(taNode.style).toEqual({ height: "240px", overflowY: "auto" });

    let prevented = false;
    await act(async () =>
      ta().props.onKeyDown(key("Enter", { shiftKey: true, preventDefault: () => (prevented = true) })),
    );
    expect([prevented, sent]).toEqual([false, []]);

    taNode.scrollHeight = 44;
    await act(async () => ta().props.onKeyDown(key("Enter", { preventDefault: () => (prevented = true) })));
    expect([prevented, ta().props.value, taNode.style]).toEqual([true, "", { height: "44px", overflowY: "hidden" }]);

    await act(async () => ta().props.onChange({ target: { value: "Second" } }));
    await act(async () => ta().props.onKeyDown(key("Enter", { metaKey: true })));
    await act(async () => ta().props.onKeyDown(key("Escape")));
    expect([sent, interrupts]).toEqual([["Line 1\nLine 2", "Second"], 2]);
  } finally {
    mock.restore();
    await act(async () => renderer?.unmount());
  }
});
