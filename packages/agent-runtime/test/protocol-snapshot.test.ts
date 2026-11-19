import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const protocolSource = new URL("../src/protocol.ts", import.meta.url);
const snapshotFile = new URL("./fixtures/protocol.snapshot.d.ts", import.meta.url);

function normalizeWhitespace(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

test("runtime protocol declarations match the checked-in snapshot", () => {
  const { outputText, diagnostics } = ts.transpileDeclaration(readFileSync(protocolSource, "utf8"), {
    fileName: "protocol.ts",
    compilerOptions: { removeComments: true, newLine: ts.NewLineKind.LineFeed },
    reportDiagnostics: true,
  });
  expect(
    (diagnostics ?? []).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  ).toEqual([]);

  const actual = `${normalizeWhitespace(outputText)}\n`;
  if (process.env.UPDATE_PROTOCOL_SNAPSHOT === "1") {
    writeFileSync(snapshotFile, actual);
  }
  expect(
    normalizeWhitespace(readFileSync(snapshotFile, "utf8")),
    "Update the snapshot with UPDATE_PROTOCOL_SNAPSHOT=1 bun test packages/agent-runtime/test/protocol-snapshot.test.ts. " +
      "Bump PROTOCOL_VERSION only for breaking changes as defined in packages/agent-runtime/src/protocol.ts.",
  ).toBe(normalizeWhitespace(actual));
});
