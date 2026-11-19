import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const snapshot = new URL("./fixtures/docker-host-protocol.snapshot.txt", import.meta.url);

test("Docker daemon wire declarations match the checked-in snapshot", () => {
  const sources = [
    ["docker-host-protocol.ts", []],
    ["docker-host-wire.ts", []],
    ["docker-host-job.ts", []],
    ["docker-machine.ts", ["DockerMachineRequest"]],
    ["docker-image.ts", ["DockerSnapshotBinding"]],
    ["docker-resource-policy.ts", ["DockerHostResources", "DockerSandboxLimits"]],
    ["golden-config.ts", ["GoldenConfig", "GoldenRepo"]],
    ["docker-api.ts", ["DockerHostVersionOffer", "DOCKER_JOB_FAILURE_REASONS", "DockerJobFailureReason"]],
    ["snapshot-baseline.ts", ["checks", "SnapshotBaselineTool"]],
  ] as const;
  const actual =
    sources
      .map(([fileName, declarations]) => {
        const source = readFileSync(new URL(`../../core/src/${fileName}`, import.meta.url), "utf8");
        const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest);
        const selected = parsed.statements.filter((statement) => {
          const name = ts.isVariableStatement(statement)
            ? statement.declarationList.declarations[0]?.name
            : ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
              ? statement.name
              : undefined;
          return name && (declarations as readonly string[]).includes(name.getText(parsed));
        });
        expect(selected).toHaveLength(declarations.length);
        const input = declarations.length ? selected.map((statement) => statement.getText(parsed)).join("\n") : source;
        const { outputText, diagnostics } = ts.transpileDeclaration(input, {
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
