import { afterEach, expect, test } from "bun:test";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Dialog } from "@/components/ui/dialog";
import { CommandMenuPalette } from "./command-menu-palette";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const orig = { ResizeObserver: globalThis.ResizeObserver, document: globalThis.document };
afterEach(() => {
  /* oxlint-disable landmines-testing/no-test-doubles -- Restore browser globals in DOM-free renderer tests. */
  Object.assign(globalThis, orig);
  /* oxlint-enable landmines-testing/no-test-doubles */
});

test("CommandMenuPalette renders a Live sandboxes group and navigates to the selected sandbox", async () => {
  /* oxlint-disable landmines-testing/no-test-doubles -- cmdk expects ResizeObserver and document queries in DOM-free renderer tests. */
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.document = {
    activeElement: { hasAttribute: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
  } as unknown as Document;
  /* oxlint-enable landmines-testing/no-test-doubles */

  const pushed: string[] = [];
  let closed = 0;
  const router = {
    back() {},
    forward() {},
    refresh() {},
    push: (href: string) => void pushed.push(href),
    replace() {},
    prefetch() {},
    bfcacheId: "test",
  } satisfies AppRouterInstance;

  let tree!: ReactTestRenderer;
  const render = (liveSandboxes: { id: string; label: string; status: "running" | "ready"; working: boolean }[]) =>
    act(async () => {
      tree = create(
        <AppRouterContext.Provider value={router}>
          <Dialog open>
            <CommandMenuPalette
              organizationAdmin={false}
              liveSandboxes={liveSandboxes}
              onDone={() => {
                closed += 1;
              }}
            />
          </Dialog>
        </AppRouterContext.Provider>,
      );
    });

  await render([
    { id: "sb-live-1", label: "fix-checkout", status: "running", working: true },
    { id: "sb-live-2", label: "codex-api", status: "ready", working: false },
  ]);
  const serialized = JSON.stringify(tree.toJSON());
  for (const text of ["Live sandboxes", "fix-checkout", "Working", "codex-api", "Waiting for you"]) {
    expect(serialized).toContain(text);
  }
  const cmdItem = tree.root.find(
    (node) => node.props.value === "sandbox:sb-live-1" && typeof node.props.onSelect === "function",
  );
  await act(async () => cmdItem.props.onSelect("sandbox:sb-live-1"));
  expect([pushed, closed]).toEqual([["/sandboxes/sb-live-1"], 1]);
  await act(async () => tree.unmount());

  await render([]);
  expect(JSON.stringify(tree.toJSON())).not.toContain("Live sandboxes");
  await act(async () => tree.unmount());
});
