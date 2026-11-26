import { afterEach, expect, mock, test } from "bun:test";
import { type ComponentType, lazy, Suspense, useContext } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SandboxPorts } from "./sandbox-ports";
import { SandboxThreadStateProvider, ThreadStateContext } from "./sandbox-thread-state";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type MintResult =
  | { ok: true; ticket: { ticket: string; wsUrl: string; expiresAt: string; bootstrapUrl?: string } }
  | { ok: false; error: string };
let mintImpl: (sandboxId: string, input: unknown) => Promise<MintResult> = async () => ({ ok: false, error: "unset" });

const xtermLog = { constructed: 0, fitCalls: 0, focusCalls: 0, disposeCalls: 0 };
const noopDispose = () => ({ dispose() {} });

/* oxlint-disable landmines-testing/no-test-doubles -- Stub next/dynamic client lazy loader and xterm browser addons in DOM-free renderer tests. */
mock.module("next/dynamic", () => ({
  default: <P extends Record<string, unknown>>(
    loader: () => Promise<ComponentType<P> | { default: ComponentType<P> }>,
    opts?: { loading?: () => unknown },
  ) => {
    const Lazy = lazy(() =>
      loader().then((mod) => ({ default: ("default" in mod ? mod.default : mod) as ComponentType<P> })),
    );
    return (props: P) => (
      <Suspense fallback={opts?.loading ? (opts.loading() as never) : null}>
        <Lazy {...props} />
      </Suspense>
    );
  },
}));
mock.module("@xterm/xterm/css/xterm.css", () => ({}));
mock.module("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
mock.module("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = () => {
      xtermLog.fitCalls += 1;
    };
  },
}));
mock.module("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = { active: { length: 0, getLine: () => undefined } };
    constructor() {
      xtermLog.constructed += 1;
    }
    loadAddon() {}
    open() {}
    focus = () => {
      xtermLog.focusCalls += 1;
    };
    attachCustomKeyEventHandler() {}
    onData = noopDispose;
    onBinary = noopDispose;
    onResize = noopDispose;
    write = (_d: unknown, ack?: () => void) => ack?.();
    clear() {}
    getSelection = () => "";
    dispose = () => {
      xtermLog.disposeCalls += 1;
    };
  },
}));
mock.module("@/app/actions/sandboxes", () => ({
  mintRelayTicket: (sandboxId: string, input: unknown) => mintImpl(sandboxId, input),
}));
/* oxlint-enable landmines-testing/no-test-doubles */

const { SandboxDetailsPanel } = await import("./sandbox-details-panel");

const orig = {
  window: globalThis.window,
  document: globalThis.document,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  getComputedStyle: globalThis.getComputedStyle,
  ResizeObserver: globalThis.ResizeObserver,
};

afterEach(() => {
  /* oxlint-disable landmines-testing/no-test-doubles -- Restore browser globals in DOM-free renderer tests. */
  Object.assign(globalThis, orig);
  /* oxlint-enable landmines-testing/no-test-doubles */
});

function installPreviewDom(openImpl: (url?: string, target?: string) => Window | null) {
  const submitted: { action: string; target: string; rel: string | undefined; ticket: string | undefined }[] = [];
  const windowEvents = new EventTarget();
  const storage = new Map<string, string>();
  const composerFocusCalls: unknown[] = [];
  /* oxlint-disable landmines-testing/no-test-doubles -- Stub browser globals in DOM-free tests. */
  globalThis.requestAnimationFrame = (cb) => {
    cb(0);
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.getComputedStyle = (() => ({ getPropertyValue: () => "" })) as unknown as typeof getComputedStyle;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.window = {
    innerHeight: 900,
    open: openImpl,
    matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  } as unknown as Window & typeof globalThis;
  globalThis.document = {
    documentElement: { classList: { contains: () => false } },
    querySelector: (selector: string) =>
      selector === "[data-chat-composer]" ? { focus: (opts?: unknown) => composerFocusCalls.push(opts) } : null,
    createElement: (tag: string) =>
      tag === "form"
        ? {
            style: {},
            children: [] as { value?: string }[],
            appendChild(c: { value?: string }) {
              this.children.push(c);
            },
            submit() {
              const f = this as unknown as { action: string; target: string; rel?: string };
              submitted.push({ action: f.action, target: f.target, rel: f.rel, ticket: this.children[0]?.value });
            },
            remove() {},
          }
        : {},
    body: { appendChild() {} },
  } as unknown as Document;
  /* oxlint-enable landmines-testing/no-test-doubles */
  return { submitted, windowEvents, storage, composerFocusCalls };
}

const okTicket = (ticket: string) =>
  ({
    ok: true,
    ticket: {
      ticket,
      wsUrl: "wss://relay.test/ws",
      bootstrapUrl: "https://relay.test/api/v1/relay/preview/enter",
      expiresAt: "2026-11-26T08:00:00Z",
    },
  }) satisfies MintResult;

test("SandboxPorts opens a named window synchronously before minting, submits to it, and closes it on error", async () => {
  const opened: { target: string | undefined; opener: unknown; closed: boolean; closeCalls: number }[] = [];
  const { submitted } = installPreviewDom((_url, target) => {
    const popup = {
      target,
      opener: globalThis.window,
      closed: false,
      closeCalls: 0,
      close() {
        this.closed = true;
        this.closeCalls += 1;
      },
    };
    opened.push(popup);
    return popup as unknown as Window;
  });

  const deferred = Promise.withResolvers<MintResult>();
  mintImpl = () => deferred.promise;

  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<SandboxPorts sandboxId="sb-1" />);
  });
  const form = tree.root.findByType("form");
  await act(async () => {
    form.props.onSubmit({ preventDefault() {} });
    form.props.onSubmit({ preventDefault() {} });
  });
  expect(opened).toHaveLength(1);
  expect(opened[0]!.target).toMatch(/^armada-preview-sb-1-3000-/);
  expect(opened[0]!.opener).toBeNull();
  expect(submitted).toEqual([]);

  await act(async () => {
    deferred.resolve(okTicket("t-ok"));
    await Promise.resolve();
  });
  expect(submitted).toEqual([
    {
      action: "https://relay.test/api/v1/relay/preview/enter",
      target: opened[0]!.target!,
      rel: undefined,
      ticket: "t-ok",
    },
  ]);

  mintImpl = async () => ({ ok: false, error: "Sandbox is not ready." });
  await act(async () => form.props.onSubmit({ preventDefault() {} }));
  expect(opened).toHaveLength(2);
  expect(opened[1]!.closeCalls).toBe(1);
  expect(tree.root.findByProps({ role: "alert" }).children.join("")).toBe("Sandbox is not ready.");
});

test("SandboxPorts renders an explicit fallback button instead of false success when popup is blocked", async () => {
  const { submitted } = installPreviewDom(() => null);
  mintImpl = async () => okTicket("t-blocked");
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<SandboxPorts sandboxId="sb-2" />);
  });
  await act(async () => tree.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(submitted).toEqual([]);
  expect(tree.root.findByProps({ role: "alert" }).children.join("")).toContain("blocked");
  const fallback = tree.root
    .findAllByType("button")
    .find((btn) => btn.findAll(() => true).some((n) => n.children?.join?.("") === "Open port 3000 preview"));
  expect(fallback).toBeDefined();
  await act(async () => fallback!.props.onClick());
  expect(submitted).toEqual([
    { action: "https://relay.test/api/v1/relay/preview/enter", target: "_blank", rel: "noopener", ticket: "t-blocked" },
  ]);
});

test("Terminal button and Ports panel appear reactively only after live status confirms ready", async () => {
  installPreviewDom(() => null);
  let pushStatus!: (status: "starting" | "ready" | "stopped", hasLiveStatus?: boolean) => void;
  function StatusDriver() {
    const ctx = useContext(ThreadStateContext);
    pushStatus = (status, hasLiveStatus = true) =>
      ctx?.setLive({ status, idlePaused: false, statusMessage: null, hasLiveStatus, turnRunning: false });
    return null;
  }
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <SandboxThreadStateProvider>
        <SandboxDetailsPanel
          bar={<span />}
          overview={<SandboxPorts sandboxId="sb-3" initialStatus="starting" />}
          usage={<span />}
          terminalSandboxId="sb-3"
          initialStatus="starting"
        >
          <StatusDriver />
        </SandboxDetailsPanel>
      </SandboxThreadStateProvider>,
    );
  });
  const terminalButtons = () =>
    tree.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Toggle terminal");
  const portsSections = () =>
    tree.root.findAll((node) => node.type === "section" && node.props["aria-label"] === "Ports");
  expect([terminalButtons().length, portsSections().length]).toEqual([0, 0]);
  await act(async () => pushStatus("ready", false));
  expect([terminalButtons().length, portsSections().length]).toEqual([0, 0]);
  await act(async () => pushStatus("ready", true));
  expect([terminalButtons().length, portsSections().length]).toEqual([1, 1]);
  await act(async () => pushStatus("stopped", true));
  expect([terminalButtons().length, portsSections().length]).toEqual([0, 0]);
});

test("SandboxPorts explains path-prefixed previews and updates localhost port hint", async () => {
  installPreviewDom(() => null);
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<SandboxPorts sandboxId="sb-note" />);
  });
  expect(JSON.stringify(tree.toJSON())).toMatch(/path-prefixed.*localhost.*3000/);
  const port5173 = tree.root.findAllByType("button").find((btn) => btn.children.join("") === ":5173");
  await act(async () => port5173!.props.onClick());
  expect(JSON.stringify(tree.toJSON())).toContain("5173");
});

test("SandboxDetailsPanel keeps terminal PTY alive on Ctrl+` hide, restores fit/focus and height, and disconnects only on Close or stop", async () => {
  Object.assign(xtermLog, { constructed: 0, fitCalls: 0, focusCalls: 0, disposeCalls: 0 });
  const { windowEvents, storage, composerFocusCalls } = installPreviewDom(() => null);
  let mintCalls = 0;
  mintImpl = async () => ({ ok: false, error: `stub-${++mintCalls}` });
  let pushStatus!: (status: "ready" | "stopped") => void;
  function StatusDriver() {
    const ctx = useContext(ThreadStateContext);
    pushStatus = (status) =>
      ctx?.setLive({ status, idlePaused: false, statusMessage: null, hasLiveStatus: true, turnRunning: false });
    return null;
  }

  let tree!: ReactTestRenderer;
  const nodeMock = (el: { type: unknown; props?: unknown }) =>
    el.type === "div" && String((el.props as Record<string, unknown> | undefined)?.className ?? "").includes("xterm")
      ? { clientWidth: 640, clientHeight: 272 }
      : null;
  await act(async () => {
    tree = create(
      <SandboxThreadStateProvider>
        <SandboxDetailsPanel
          bar={<span />}
          overview={<span />}
          usage={<span />}
          terminalSandboxId="sb-pty"
          initialStatus="ready"
        >
          <StatusDriver />
        </SandboxDetailsPanel>
      </SandboxThreadStateProvider>,
      { createNodeMock: nodeMock },
    );
  });

  const btn = (label: string) => tree.root.find((n) => n.type === "button" && n.props["aria-label"] === label);
  const terminals = () => tree.root.findAll((n) => n.type === "section" && n.props["data-slot"] === "sandbox-terminal");
  const isHidden = () => String(terminals()[0]!.props.className).split(/\s+/).includes("hidden");
  const ctrlBackquote = () =>
    act(async () => {
      windowEvents.dispatchEvent(
        Object.assign(new Event("keydown", { cancelable: true }), {
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          code: "Backquote",
        }),
      );
      await Promise.resolve();
    });

  await import("@/components/sandbox-terminal");
  await act(async () => btn("Toggle terminal").props.onClick());
  for (let i = 0; i < 5 && terminals().length === 0; i += 1) await act(async () => void (await Promise.resolve()));
  expect([
    terminals().length,
    isHidden(),
    xtermLog.constructed,
    xtermLog.fitCalls,
    xtermLog.focusCalls,
    mintCalls,
  ]).toEqual([1, false, 1, 1, 1, 1]);

  await act(async () => btn("Resize terminal").props.onKeyDown({ key: "ArrowUp", preventDefault() {} }));
  expect(storage.get("armada:terminal-height")).toBe("296");

  await ctrlBackquote();
  expect([terminals().length, isHidden(), xtermLog.disposeCalls, composerFocusCalls]).toEqual([
    1,
    true,
    0,
    [{ preventScroll: true }],
  ]);

  await ctrlBackquote();
  expect([
    terminals().length,
    isHidden(),
    xtermLog.constructed,
    xtermLog.fitCalls,
    xtermLog.focusCalls,
    mintCalls,
  ]).toEqual([1, false, 1, 2, 2, 1]);

  await act(async () => btn("Close terminal").props.onClick());
  expect([terminals().length, xtermLog.disposeCalls]).toEqual([0, 1]);

  await ctrlBackquote();
  const hostWrapper = terminals()[0]!
    .findAllByType("div")
    .find((d) => d.props.style?.height !== undefined);
  expect([terminals().length, xtermLog.constructed, hostWrapper?.props.style?.height]).toEqual([1, 2, 296]);

  await act(async () => pushStatus("stopped"));
  expect([terminals().length, xtermLog.disposeCalls]).toEqual([0, 2]);
});
