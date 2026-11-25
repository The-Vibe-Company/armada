import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import * as markdownLib from "@/lib/markdown";
import { Markdown } from "./markdown";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const origNavigator = globalThis.navigator;
afterEach(() => {
  mock.restore();
  /* oxlint-disable landmines-testing/no-test-doubles -- Restore browser navigator global in the DOM-free renderer. */
  Object.defineProperty(globalThis, "navigator", { value: origNavigator, configurable: true, writable: true });
  /* oxlint-enable landmines-testing/no-test-doubles */
});

test("Markdown memoizes completed top-level blocks and renders fenced code language label with copy feedback", async () => {
  const parseSpy = spyOn(markdownLib, "parseMarkdownBlock");
  const copied: string[] = [];
  let shouldFail = false;
  /* oxlint-disable landmines-testing/no-test-doubles -- Supply deterministic clipboard API in the DOM-free renderer. */
  const clipboard = {
    writeText: async (v: string) => {
      if (shouldFail) throw new Error("denied");
      copied.push(v);
    },
  };
  Object.defineProperty(globalThis, "navigator", { value: { clipboard }, configurable: true, writable: true });
  /* oxlint-enable landmines-testing/no-test-doubles */
  let renderer!: ReactTestRenderer;
  try {
    const prefix = "First **block**.\n\n```ts\nconst x = 42;\n```\n\n```\nplain\n```\n\n";
    await act(async () => {
      renderer = create(<Markdown text={`${prefix}Stream`} />);
    });
    expect(parseSpy).toHaveBeenCalledTimes(4);
    parseSpy.mockClear();
    await act(async () => renderer.update(<Markdown text={`${prefix}Stream more`} />));
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(parseSpy).toHaveBeenCalledWith("Stream more");

    const langs = renderer.root.findAllByProps({ "data-code-language": true }).map((n) => n.children.join(""));
    const buttons = () => renderer.root.findAllByType("button");
    expect([langs, buttons().map((b) => b.props["aria-label"])]).toEqual([
      ["ts", "text"],
      ["Copy ts code", "Copy code"],
    ]);
    await act(async () => buttons()[0]!.props.onClick());
    expect([copied, buttons()[0]!.props["data-copy-state"]]).toEqual([["const x = 42;"], "copied"]);
    expect(JSON.stringify(renderer.toJSON())).toContain("Copied");
    shouldFail = true;
    await act(async () => buttons()[1]!.props.onClick());
    expect(buttons()[1]!.props["data-copy-state"]).toBe("failed");
  } finally {
    await act(async () => renderer?.unmount());
  }
});
