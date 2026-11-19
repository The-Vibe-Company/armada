import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const snapshot = new URL("./fixtures/docker-host-protocol.snapshot.txt", import.meta.url);

test("Docker daemon wire declarations match the checked-in snapshot", () => {
  const sources = ["docker-host-protocol.ts", "docker-host-wire.ts", "docker-host-job.ts"];
  const actual =
    sources
      .map((fileName) => {
        const source = readFileSync(new URL(`../../core/src/${fileName}`, import.meta.url), "utf8");
        const { outputText, diagnostics } = ts.transpileDeclaration(source, {
          fileName,
          compilerOptions: { removeComments: true, newLine: ts.NewLineKind.LineFeed },
          reportDiagnostics: true,
        });
        expect((diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
        return outputText.trim();
      })
      .join("\n\n") + "\n";
  if (process.env.UPDATE_PROTOCOL_SNAPSHOT === "1") writeFileSync(snapshot, actual);
  expect(
    readFileSync(snapshot, "utf8").replaceAll("\r\n", "\n"),
    "Update with UPDATE_PROTOCOL_SNAPSHOT=1 bun test packages/docker-host/test/protocol-snapshot.test.ts. " +
      "Bump DOCKER_HOST_PROTOCOL only for breaking changes.",
  ).toBe(actual);
});
