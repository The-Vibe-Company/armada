import { describe, expect, test } from "bun:test";
import { parseInline, parseMarkdown } from "../src/lib/markdown.ts";

describe("markdown", () => {
  test("only web and mail links keep a target; script and data links and raw HTML stay text", () => {
    const nodes = parseInline("[ok](https://example.com/a) [x](javascript:alert(1)) [y](data:text/html,hi)");
    expect(nodes.flatMap((node) => (node.kind === "link" ? [node.href] : []))).toEqual(["https://example.com/a"]);
    expect(nodes.map((node) => (node.kind === "text" ? node.text : "[link]")).join("")).toBe("[link] x y");
    expect(parseMarkdown("<img src=x onerror=alert(1)>")).toEqual([
      { kind: "paragraph", children: [{ kind: "text", text: "<img src=x onerror=alert(1)>" }] },
    ]);
  });

  test("agent answers keep their code, lists and emphasis", () => {
    expect(parseMarkdown("Run **this**:\n\n```sh\nbun test\n# not a heading\n```\n- `a`\n- b")).toEqual([
      {
        kind: "paragraph",
        children: [
          { kind: "text", text: "Run " },
          { kind: "strong", children: [{ kind: "text", text: "this" }] },
          { kind: "text", text: ":" },
        ],
      },
      { kind: "code", language: "sh", text: "bun test\n# not a heading" },
      { kind: "list", ordered: false, start: 1, items: [[{ kind: "code", text: "a" }], [{ kind: "text", text: "b" }]] },
    ]);
  });
});
