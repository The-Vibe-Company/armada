import { afterEach, expect, mock, test } from "bun:test";
import { useContext } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SandboxDetailsPanel } from "./sandbox-details-panel";
import { SandboxPorts } from "./sandbox-ports";
import { SandboxThreadStateProvider, ThreadStateContext } from "./sandbox-thread-state";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type MintResult =
  | { ok: true; ticket: { ticket: string; wsUrl: string; expiresAt: string; bootstrapUrl?: string } }
  | { ok: false; error: string };
let mintImpl: (sandboxId: string, input: unknown) => Promise<MintResult> = async () => ({ ok: false, error: "unset" });

mock.module("@/app/actions/sandboxes", () => ({
  mintRelayTicket: (sandboxId: string, input: unknown) => mintImpl(sandboxId, input),
}));

const orig = {
  window: globalThis.window,
  document: globalThis.document,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
};

afterEach(() => {
  /* oxlint-disable landmines-testing/no-test-doubles -- Restore browser globals in DOM-free renderer tests. */
  Object.assign(globalThis, orig);
  /* oxlint-enable landmines-testing/no-test-doubles */
});

function installPreviewDom(openImpl: (url?: string, target?: string) => Window | null) {
  const submitted: { action: string; target: string; rel: string | undefined; ticket: string | undefined }[] = [];
  /* oxlint-disable landmines-testing/no-test-doubles -- Stub window.open and hidden form submission in DOM-free tests. */
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = {
    open: openImpl,
    matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window & typeof globalThis;
  globalThis.document = {
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
  return { submitted };
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
